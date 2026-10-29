/**
 * Guided tours. Each step points at an element marked `data-tour="<target>"`; a test fails when a
 * target no longer exists in the source, so tours cannot silently break. Text may use vocabulary
 * placeholders (`{{dealPluralLower}}`), like help articles.
 */
export interface TourStep {
  target: string;
  title: string;
  body: string;
}

export interface Tour {
  id: string;
  title: string;
  /** Where the tour runs; the tour opens this page first. */
  route: string;
  /** Hidden from people without it. */
  permission?: string;
  steps: TourStep[];
}

export const TOURS: Tour[] = [
  {
    id: 'welcome',
    title: 'Welcome tour',
    route: '/',
    steps: [
      {
        target: 'nav',
        title: 'Everything in one place',
        body: 'Your lists live here: {{contactPluralLower}}, {{organizationPluralLower}}, {{dealPluralLower}}, tasks and the modules your workspace uses.',
      },
      {
        target: 'search',
        title: 'Find anything',
        body: 'Search records, pages and actions. Press ⌘K (Ctrl K) or / from anywhere.',
      },
      {
        target: 'dashboard-edit',
        title: 'Make home yours',
        body: 'Add, resize and reorder widgets, including your saved reports.',
      },
      {
        target: 'help',
        title: 'Help on every page',
        body: 'Press ? or this button to learn what a page does and what each setting means.',
      },
      {
        target: 'user-menu',
        title: 'Your profile',
        body: 'Your password, two-factor authentication, theme and keyboard shortcuts.',
      },
    ],
  },
  {
    id: 'records',
    title: 'Working with lists',
    route: '/contacts',
    permission: 'core.contacts.view',
    steps: [
      {
        target: 'new-record',
        title: 'Add a {{contactLower}}',
        body: 'Create a record here, or press c on any list.',
      },
      {
        target: 'list-toolbar',
        title: 'Search and filter',
        body: 'Narrow the list by any field, then save it as a view tab to come back to it.',
      },
    ],
  },
  {
    id: 'pipeline',
    title: 'Moving {{dealPluralLower}} forward',
    route: '/deals',
    permission: 'core.deals.view',
    steps: [
      {
        target: 'board',
        title: 'Your pipeline',
        body: 'Each column is a stage. Drag a card to move a {{dealLower}} forward; moving it to won or lost closes it.',
      },
      {
        target: 'new-record',
        title: 'Add a {{dealLower}}',
        body: 'Start a new {{dealLower}} with its value and expected close date, so it counts in the forecast.',
      },
    ],
  },
  {
    id: 'custom-fields',
    title: 'Adding custom fields',
    route: '/settings/fields',
    permission: 'core.fields.manage',
    steps: [
      {
        target: 'field-entities',
        title: 'Choose the record type',
        body: 'Fields belong to one record type: {{contactPluralLower}}, {{dealPluralLower}}, objects and more.',
      },
      {
        target: 'new-field',
        title: 'Add a field',
        body: 'Pick a type, decide whether it is required and filterable, and who can see or change it.',
      },
    ],
  },
  {
    id: 'objects',
    title: 'Setting up an object',
    route: '/settings/objects',
    permission: 'core.fields.manage',
    steps: [
      {
        target: 'new-object',
        title: 'Create an object',
        body: 'Name it, pick an icon and what each record links to. Then add fields and give roles access.',
      },
    ],
  },
];
