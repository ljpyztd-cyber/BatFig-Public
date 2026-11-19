import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  answerLeaveRequest, beginCloseRequest, cancelLeaveRequest, useLeaveGuard,
} from '@/lib/closeGuard'
import { armDesktopCloseGuard, onDesktopCloseRequested } from '@/lib/desktop'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { TextInput } from './ui/Input'

/** Browser tab/window unloading keeps its native beforeunload dialog. */
export function CloseGuardDialog() {
  const { t } = useTranslation('dialogs')
  const { request, busy, failed } = useLeaveGuard()
  const [name, setName] = useState('')
  useEffect(() => { setName(request?.defaultName ?? '') }, [request])
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let disposed = false
    void onDesktopCloseRequested(() => { void beginCloseRequest() }).then((u) => {
      if (disposed) { u(); return }
      unlisten = u
      // Subscribe before arming: every intercepted native close must have a listener.
      void armDesktopCloseGuard()
    })
    return () => { disposed = true; unlisten?.(); cancelLeaveRequest() }
  }, [])

  const canvas = request?.kind === 'canvas'
  const switching = request?.kind === 'document' || request?.kind === 'project'
  return (
    <Dialog
      open={!!request}
      onOpenChange={() => void answerLeaveRequest('cancel')}
      title={t('closeGuard.title')}
      size="md"
      busy={busy}
      blockDismiss
      anchor="unsaved-changes"
      footer={
        <>
          <Button data-leave-action="cancel" variant="secondary" size="md" disabled={busy}
            onClick={() => void answerLeaveRequest('cancel')}>
            {t('common:actions.cancel')}
          </Button>
          <Button data-leave-action="discard" variant="danger" size="md" disabled={busy}
            onClick={() => void answerLeaveRequest('discard')}>
            {t(canvas ? 'closeGuard.closeTab' : switching ? 'closeGuard.continueWithoutSave' : 'closeGuard.discard')}
          </Button>
          <Button data-leave-action="save" variant="primary" size="md" loading={busy}
            disabled={!!request?.needsName && !name.trim()}
            onClick={() => void answerLeaveRequest('save', name)}>
            {t(switching ? 'closeGuard.saveAndContinue' : 'closeGuard.save')}
          </Button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-ink-2">
        {t(canvas ? 'closeGuard.canvasBody' : 'closeGuard.body')}
      </p>
      {request?.needsName && (
        <label className="mt-3 flex flex-col gap-1 text-xs text-ink-2">
          {t('closeGuard.fileName')}
          <TextInput data-leave-filename value={name} disabled={busy}
            onChange={(event) => setName(event.target.value)} />
        </label>
      )}
      {failed && <p data-leave-error className="mt-2 text-xs leading-relaxed text-danger">
        {t('closeGuard.saveFailed')}
      </p>}
    </Dialog>
  )
}
