import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { ActivityDto } from '@app/shared';
import { ENTITY_ROUTE } from '@app/shared';
import { apiGet } from '@/lib/api';
import { useBranding } from '@/app/branding';
import { useBoot, useT } from '@/app/session';
import { setDocumentTitle } from '@/theme/apply';
import { PageHeader } from '@/components/ui/misc';
import { Switch } from '@/components/ui/checkbox';

export function CalendarPage() {
  const t = useT();
  const boot = useBoot();
  const { branding } = useBranding();
  const navigate = useNavigate();
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
          extendedProps: { related: a.related },
        };
      }),
    [q.data],
  );
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
          eventClick={(info) => {
            const related = info.event.extendedProps.related as ActivityDto['related'];
            if (related) navigate(`/${ENTITY_ROUTE[related.type]}/${related.uuid}`);
          }}
          direction={document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr'}
        />
      </div>
    </div>
  );
}
