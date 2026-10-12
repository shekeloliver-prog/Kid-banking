import { h } from '../../dom.js';
import { api } from '../../api.js';
import { defineView } from '../../view.js';
import { activityList } from '../../ui.js';

export const kidActivityView = defineView({
  title: 'Activity',
  autoRefresh: true,
  load: () => api.get('/kid/activity?limit=30'),
  render: (page) => {
    let cursor = page.nextBefore;
    return h(
      'div',
      { class: 'stack-lg' },
      h('header', { class: 'page-head', style: { marginBottom: '0' } }, h('div', null, h('h1', null, 'My activity'), h('p', null, 'Everything that’s happened with your money.'))),
      activityList(page.items, 'kid', {
        hasMore: !!cursor,
        emptyText: 'When you get, spend or save money it shows up here.',
        loadMore: async () => {
          const next = await api.get(`/kid/activity?limit=30&before=${cursor}`);
          cursor = next.nextBefore;
          return { rows: next.items, more: !!cursor };
        },
      }),
    );
  },
});
