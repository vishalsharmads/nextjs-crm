export interface LayoutWidget {
  type: string;
  size: 'sm' | 'md' | 'lg';
}

/**
 * The pipeline is what a CRM is for, so its widget leads the home screen at full width and the rest follow
 * in their stored order. Without a pipeline widget the order is untouched. Stored dashboards are not edited.
 */
export function orderWidgets<T extends LayoutWidget>(widgets: T[]): T[] {
  const lead = widgets.find((w) => w.type === 'pipeline_value');
  if (!lead) return widgets;
  return [{ ...lead, size: 'lg' }, ...widgets.filter((w) => w !== lead)];
}
