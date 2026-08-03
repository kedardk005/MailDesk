import { Toaster as SonnerToaster, toast } from 'sonner'

/**
 * Application toast host. Mounted EXACTLY ONCE in App.jsx — it replaces the
 * 18-line toast block that was copy-pasted into 7 pages.
 *
 * Usage anywhere:
 *   import { toast } from '@/components/ui'
 *   toast.success('Task created')
 *   toast.error('Could not save', { description: getErrorMessage(err) })
 *   toast.warning('Rate limited')
 *   toast.promise(save(), { loading: 'Saving…', success: 'Saved', error: 'Failed' })
 *
 * Errors are persistent (duration: Infinity) — a failure the user never saw is
 * a failure that gets reported as "the app did nothing".
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      visibleToasts={3}
      gap={8}
      offset={16}
      closeButton
      toastOptions={{
        duration: 4000,
        classNames: {
          toast:
            'group !w-[360px] !min-h-[44px] !rounded-lg !border !border-line-overlay !bg-elevated !text-fg !shadow-md !px-3.5 !py-3 !gap-2.5 !font-sans',
          title: '!text-sm !font-medium !text-fg',
          description: '!text-xs !text-fg-3',
          actionButton: '!bg-primary-600 !text-white !rounded !text-xs !h-7 !px-2',
          cancelButton: '!bg-elevated-subtle !text-fg-2 !rounded !text-xs !h-7 !px-2',
          closeButton: '!bg-elevated !border-line-overlay !text-fg-3',
          success: '!border-l-2 !border-l-success',
          error: '!border-l-2 !border-l-danger',
          warning: '!border-l-2 !border-l-warning',
          info: '!border-l-2 !border-l-info',
        },
      }}
    />
  )
}

export { toast }
export default Toaster
