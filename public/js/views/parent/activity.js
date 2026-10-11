import { h } from '../../dom.js';
import { api } from '../../api.js';
import { defineView } from '../../view.js';
import { avatar, activityList } from '../../ui.js';

export const activityView = defineView({
  title: 'Activity',
  autoRefresh: true,
  load: async () => {
    const params = new URLSearchParams((location.hash.split('?')[1] ?? ''));
    const kidParam = params.get('kid');
    const [overview, page] = await Promise.all([api.get('/parent/overview'), api.get(`/activity?limit=30${kidParam ? `&kid=${encodeURIComponent(kidParam)}` : ''}`)]);
    return { kids: overview.kids, kidId: kidParam ? Number(kidParam) : null, page };
  },
  render: ({ kids, kidId, page }) => {
    let cursor = page.nextBefore;
    const chip = (label, id, kid) =>
      h('a', { class: 'chip', href: id ? `#/activity?kid=${id}` : '#/activity', 'aria-pressed': String(kidId === id), style: { textDecoration: 'none' } }, kid ? avatar(kid, 'xs') : null, label);
    return h(
      'div',
      { class: 'stack-lg' },
      h('header', { class: 'page-head', style: { marginBottom: '0' } }, h('div', null, h('h1', null, 'Activity'), h('p', null, 'Every dollar in and out, newest first.'))),
      kids.length ? h('div', { class: 'chips' }, chip('Everyone', null), kids.map((k) => chip(k.name, k.id, k))) : null,
      activityList(page.items, 'parent', {
        hasMore: !!cursor,
        emptyText: 'Add funds or send money and it will show up here.',
        loadMore: async () => {
          const next = await api.get(`/activity?limit=30&before=${cursor}${kidId ? `&kid=${kidId}` : ''}`);
          cursor = next.nextBefore;
          return { rows: next.items, more: !!cursor };
        },
      }),
    );
  },
});
