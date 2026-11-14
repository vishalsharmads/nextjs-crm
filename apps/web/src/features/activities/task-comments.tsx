import { useCan } from '@/app/session';
import { Comments } from '@/components/comments/comments';

/** The discussion on one task: comments with mentions. */
export function TaskComments({ taskUuid }: { taskUuid: string }) {
  const can = useCan();
  return (
    <Comments
      listPath={`/activities/${taskUuid}/comments`}
      itemPath={(c) => `/activities/comments/${c}`}
      queryKey={['records', 'activities', 'comments', taskUuid]}
      canWrite={can('core.activities.update')}
    />
  );
}
