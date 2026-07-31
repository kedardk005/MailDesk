/**
 * Escapes special regex characters in a string to safely use inside a RegExp constructor or MongoDB $regex query.
 * @param {string} string 
 * @returns {string}
 */
const escapeRegex = (string) => {
  if (!string) return '';
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

module.exports = { escapeRegex };
