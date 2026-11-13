import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { EventDropArg } from '@fullcalendar/core';
import type { EventResizeDoneArg } from '@fullcalendar/interaction';
import type { ActivityDto } from '@app/shared';
import { apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useBranding } from '@/app/branding';
import { useBoot, useCan, useT } from '@/app/session';
import { setDocumentTitle } from '@/theme/apply';
import { PageHeader } from '@/components/ui/misc';
import { Switch } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { Dialog, DialogContent } from '@/components/ui/dialog';

type Slot = { start: Date; end: Date; allDay: boolean };

/** Create a meeting or task in a selected slot. */
function NewInSlot({ slot, onClose }: { slot: Slot; onClose: () => void }) {
  const { me } = useBoot();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [subject, setSubject] = useState('');
  const [type, setType] = useState<'meeting' | 'task' | 'call'>(slot.allDay ? 'task' : 'meeting');
  const create = useMutation({
    mutationFn: () =>
      apiPost<ActivityDto>('/activities', {
        type,
        subject: subject.trim(),
        assigneeUuid: me.uuid,
        allDay: slot.allDay,
        ...(type === 'meeting'
          ? { startAt: slot.start.toISOString(), endAt: slot.end.toISOString() }
          : { dueAt: slot.start.toISOString() }),
      }),
    onSuccess: (a) => {
      toast.success('Added', { action: { label: 'Open', onClick: () => navigate(`/tasks/${a.uuid}`) } });
      void qc.invalidateQueries({ queryKey: ['activities'] });
      void qc.invalidateQueries({ queryKey: ['records', 'activities'] });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Plan something"
        description={formatDateTime(slot.start.toISOString())}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!subject.trim()}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Add
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (subject.trim()) create.mutate();
          }}
        >
          <NativeSelect
            aria-label="Type"
            value={type}
            onChange={(e) => setType(e.target.value as typeof type)}
          >
            <option value="meeting">Meeting</option>
            <option value="call">Call</option>
            <option value="task">Task</option>
          </NativeSelect>
          <Input
            autoFocus
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={type === 'meeting' ? 'Meeting title' : 'What needs doing?'}
            aria-label="Subject"
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CalendarPage() {
  const t = useT();
  const boot = useBoot();
  const { branding } = useBranding();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useCan();
  const editable = can('core.activities.update');
  const [slot, setSlot] = useState<Slot | null>(null);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [mineOnly, setMineOnly] = useState(true);
  useEffect(() => setDocumentTitle(t('nav.calendar'), branding.appName), [t, branding.appName]);
  const q = useQuery({
    queryKey: ['activities', 'calendar', range, mineOnly],
    queryFn: () =>
      apiGet<{ data: ActivityDto[] }>('/activities/calendar', {
        from: range!.from,
        to: range!.to,
        assignee: mineOnly ? '@me' : undefined,
      }).then((r) => r.data),
    enabled: !!range,
  });
  const events = useMemo(
    () =>
      (q.data ?? []).map((a) => {
        const start = a.startAt ?? a.dueAt!;
        return {
          id: a.uuid,
          title: a.subject || a.type,
          start,
          end: a.endAt ?? undefined,
          allDay: a.allDay,
          classNames: [a.completedAt ? 'opacity-50 line-through' : '', a.overdue ? 'fc-overdue' : ''],
          extendedProps: { type: a.type },
          editable: editable && !a.completedAt,
          durationEditable: a.type === 'meeting',
        };
      }),
    [q.data, editable],
  );
  // Dragging moves the item; resizing a meeting changes its end. Undo puts it back.
  const move = async (info: EventDropArg | EventResizeDoneArg) => {
    const e = info.event;
    const isMeeting = e.extendedProps.type === 'meeting';
    const body = isMeeting
      ? { startAt: e.start?.toISOString() ?? null, endAt: e.end?.toISOString() ?? null, allDay: e.allDay }
      : { dueAt: e.start?.toISOString() ?? null, allDay: e.allDay };
    const old = info.oldEvent;
    const undo = isMeeting
      ? {
          startAt: old.start?.toISOString() ?? null,
          endAt: old.end?.toISOString() ?? null,
          allDay: old.allDay,
        }
      : { dueAt: old.start?.toISOString() ?? null, allDay: old.allDay };
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: ['activities'] });
      void qc.invalidateQueries({ queryKey: ['records', 'activities'] });
    };
    try {
      await apiPatch(`/activities/${e.id}`, body);
      refresh();
      toast.success(`Moved to ${formatDateTime(e.start?.toISOString())}`, {
        action: { label: 'Undo', onClick: () => void apiPatch(`/activities/${e.id}`, undo).then(refresh) },
      });
    } catch {
      info.revert();
      toast.error('Could not move it. Try again.');
    }
  };
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('nav.calendar')}
        actions={
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={mineOnly} onCheckedChange={setMineOnly} /> Only mine
          </label>
        }
      />
      <div className="min-h-0 flex-1 bg-surface p-3 md:p-4">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="timeGridWeek"
          headerToolbar={{
            start: 'prev,next today',
            center: 'title',
            end: 'dayGridMonth,timeGridWeek,timeGridDay',
          }}
          height="100%"
          firstDay={boot.settings.general.weekStartsOn}
          nowIndicator
          events={events}
          datesSet={(info) => setRange({ from: info.start.toISOString(), to: info.end.toISOString() })}
          eventClick={(info) => navigate(`/tasks/${info.event.id}`)}
          selectable={editable}
          selectMirror
          select={(info) => {
            setSlot({ start: info.start, end: info.end, allDay: info.allDay });
            info.view.calendar.unselect();
          }}
          eventDrop={(info) => void move(info)}
          eventResize={(info) => void move(info)}
          direction={document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr'}
        />
      </div>
      {slot ? <NewInSlot slot={slot} onClose={() => setSlot(null)} /> : null}
    </div>
  );
}
