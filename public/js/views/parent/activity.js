import { h } from '../../dom.js';
import { api, download } from '../../api.js';
import { icon } from '../../icons.js';
import { toast } from '../../ui.js';
import { defineView } from '../../view.js';
import { avatar, filteredActivity } from '../../ui.js';

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
    const kidQuery = kidId ? `&kid=${kidId}` : '';
    const list = filteredActivity({
      view: 'parent',
      first: page,
      emptyText: 'Add funds or send money and it will show up here.',
      fetchPage: (before, query) => api.get(`/activity?limit=30${before ? `&before=${before}` : ''}${kidQuery}${query}`),
    });
    const chip = (label, id, kid) =>
      h('a', { class: 'chip', href: id ? `#/activity?kid=${id}` : '#/activity', 'aria-pressed': String(kidId === id), style: { textDecoration: 'none' } }, kid ? avatar(kid, 'xs') : null, label);
    return h(
      'div',
      { class: 'stack-lg' },
      h(
        'header',
        { class: 'page-head', style: { marginBottom: '0' } },
        h('div', null, h('h1', null, 'Activity'), h('p', null, 'Every dollar in and out, newest first. Search or filter to find something.')),
        h('button', { class: 'btn', onClick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await download(`/export.csv?${new URLSearchParams(`${kidQuery}${list.query()}`.slice(1)).toString()}`, 'nestly-activity.csv'); } catch (err) { toast(err.message, { tone: 'error' }); } finally { b.disabled = false; } } }, icon('download', 17), 'Export CSV'),
      ),
      kids.length ? h('div', { class: 'chips' }, chip('Everyone', null), kids.map((k) => chip(k.name, k.id, k))) : null,
      list.el,
    );
  },
});
