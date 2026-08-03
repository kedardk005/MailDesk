/**
 * Shared list-endpoint pagination.
 *
 * Implements docs/audits/API-LIST-CONTRACT.md, which is normative — the client
 * pages are written against exactly this shape.
 *
 *   Request:  ?page=1&limit=25&sort=-createdAt&q=foo   (+ endpoint filters)
 *   Response: { data: [...], pagination: { page, limit, total, totalPages, hasMore } }
 *
 * When `page` is ABSENT the endpoint keeps its historical response shape, but
 * bounded to a hard server-side cap (default 200 documents). The real defect
 * these endpoints had was being unbounded, not lacking a page parameter, so the
 * cap applies to legacy callers too.
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const LEGACY_CAP = Number(process.env.LIST_LEGACY_CAP || 200);

/**
 * Express 5 yields an array for a repeated query parameter, and `?q[$ne]=` used
 * to yield an object. Collapse anything that is not a string to a safe string.
 * @param {*} value
 * @param {Number} [maxLength]
 * @returns {String}
 */
const firstString = (value, maxLength = 200) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return '';
  return raw.slice(0, maxLength);
};

/**
 * Parse and clamp the list parameters for one request.
 *
 * @param {Object} req - express request
 * @param {Object} options
 * @param {String[]} options.sortWhitelist - sortable field names for this endpoint
 * @param {String} options.defaultSort - e.g. '-createdAt'
 * @param {Number} [options.defaultLimit]
 * @param {Number} [options.maxLimit]
 * @param {Number} [options.legacyCap]
 * @param {String} [options.tiebreaker] - secondary sort key for a stable page boundary
 * @returns {{paginated: Boolean, page: Number, limit: Number, skip: Number,
 *           sort: Object, sortParam: String, q: String}}
 */
const parseListParams = (req, options = {}) => {
  const {
    sortWhitelist = [],
    defaultSort = '-createdAt',
    defaultLimit = DEFAULT_LIMIT,
    maxLimit = MAX_LIMIT,
    legacyCap = LEGACY_CAP,
    tiebreaker = '_id'
  } = options;

  const query = req.query || {};

  // "Paginated form is returned when `page` is present in the query string."
  const rawPage = firstString(query.page, 20);
  const paginated = rawPage !== '';

  const parsedPage = parseInt(rawPage, 10);
  const page = paginated && Number.isFinite(parsedPage) && parsedPage >= 1 ? parsedPage : 1;

  // "Values above 100 clamp to 100, never error."
  const parsedLimit = parseInt(firstString(query.limit, 20), 10);
  const limit = paginated
    ? Number.isFinite(parsedLimit) && parsedLimit >= 1
      ? Math.min(parsedLimit, maxLimit)
      : defaultLimit
    : legacyCap;

  // "Whitelist server-side; an unknown field falls back to the default rather
  // than erroring."
  const requested = firstString(query.sort, 60) || defaultSort;
  const requestedField = requested.startsWith('-') ? requested.slice(1) : requested;
  const effective = sortWhitelist.includes(requestedField) ? requested : defaultSort;
  const field = effective.startsWith('-') ? effective.slice(1) : effective;
  const direction = effective.startsWith('-') ? -1 : 1;

  const sort = { [field]: direction };
  // Without a tiebreaker two documents with an identical sort key can appear on
  // two consecutive pages (or on neither).
  if (tiebreaker && tiebreaker !== field) sort[tiebreaker] = direction;

  return {
    paginated,
    page,
    limit,
    skip: paginated ? (page - 1) * limit : 0,
    sort,
    sortParam: effective,
    q: firstString(query.q, 200).trim()
  };
};

/**
 * Run the page query and (in paginated mode only) `countDocuments` with the
 * same filter, in parallel.
 *
 * Legacy mode deliberately skips the count: the legacy response shape has no
 * total, so paying for a full count would be pure waste.
 *
 * @param {import('mongoose').Model} model
 * @param {Object} filter
 * @param {Object} params - result of parseListParams
 * @param {Object} [options]
 * @param {String|Object} [options.select] - projection; ALWAYS set one on a list
 * @param {Array} [options.populate] - array of mongoose populate specs
 * @param {Boolean} [options.lean=true]
 * @param {Object} [options.collation]
 * @returns {Promise<{data: Array, pagination: Object|null}>}
 */
const paginate = async (model, filter, params, options = {}) => {
  const { select, populate = [], lean = true, collation } = options;

  const build = () => {
    let q = model.find(filter);
    if (select) q = q.select(select);
    for (const spec of populate) q = q.populate(spec);
    q = q.sort(params.sort).skip(params.skip).limit(params.limit);
    if (collation) q = q.collation(collation);
    if (lean) q = q.lean();
    return q;
  };

  const [data, total] = await Promise.all([
    build().exec(),
    params.paginated ? model.countDocuments(filter) : Promise.resolve(null)
  ]);

  return { data, pagination: params.paginated ? buildPagination(params, total) : null };
};

/**
 * @param {Object} params
 * @param {Number} total
 * @returns {{page: Number, limit: Number, total: Number, totalPages: Number, hasMore: Boolean}}
 */
const buildPagination = (params, total) => {
  const safeTotal = Number.isFinite(total) ? total : 0;
  const totalPages = params.limit > 0 ? Math.ceil(safeTotal / params.limit) : 0;
  return {
    page: params.page,
    limit: params.limit,
    total: safeTotal,
    totalPages,
    hasMore: params.page < totalPages
  };
};

/**
 * Send a list response in the correct form for this request.
 *
 * @param {Object} res - express response
 * @param {Object} args
 * @param {Object} args.params - result of parseListParams
 * @param {Array} args.data
 * @param {Object|null} args.pagination
 * @param {Function} [args.legacy] - (data) => legacy body; defaults to the bare array
 * @returns {Object} the express response
 */
const listResponse = (res, { params, data, pagination, legacy }) => {
  if (params.paginated) {
    return res.status(200).json({ data, pagination });
  }
  return res.status(200).json(legacy ? legacy(data) : data);
};

module.exports = {
  parseListParams,
  paginate,
  buildPagination,
  listResponse,
  firstString,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  LEGACY_CAP
};
