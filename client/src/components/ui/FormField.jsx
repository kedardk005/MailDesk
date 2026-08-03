import { useId } from 'react'
import { AlertCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Label } from './Label'

/**
 * Label + control + hint + error, correctly wired for accessibility.
 *
 * `children` is a render function receiving the props the control must spread:
 *
 *   <FormField label="Client name" required error={errors.client} hint="As on the invoice">
 *     {(field) => <Input {...field} value={v} onChange={...} />}
 *   </FormField>
 *
 * The field object is `{ id, 'aria-describedby', 'aria-invalid', invalid, required }`.
 * A plain element child also works — it is cloned with the same props.
 *
 * @param {string} label
 * @param {boolean} [required]
 * @param {string} [error]  - when set, the control turns red and the message is
 *                            announced via role="alert"
 * @param {string} [hint]   - help text below the control
 * @param {string} [id]     - override the generated id
 */
export function FormField({
  label,
  required = false,
  error,
  hint,
  id: idProp,
  className,
  labelClassName,
  optionalText,
  children,
}) {
  const generated = useId()
  const id = idProp || `field-${generated}`
  const errorId = `${id}-error`
  const hintId = `${id}-hint`

  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ')

  const field = {
    id,
    required,
    invalid: Boolean(error),
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy || undefined,
  }

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label ? (
        <Label htmlFor={id} required={required} optionalText={optionalText} className={labelClassName}>
          {label}
        </Label>
      ) : null}

      {typeof children === 'function' ? children(field) : children}

      {hint && !error ? (
        <p id={hintId} className="text-xs text-fg-3">
          {hint}
        </p>
      ) : null}

      {error ? (
        <p id={errorId} role="alert" className="flex items-start gap-1 text-xs text-danger-text">
          <AlertCircle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  )
}

export default FormField
