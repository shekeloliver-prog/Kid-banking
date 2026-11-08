import { h } from '../../dom.js';
import { api } from '../../api.js';
import { defineView } from '../../view.js';
import { filteredActivity } from '../../ui.js';

export const kidActivityView = defineView({
  title: 'Activity',
  autoRefresh: true,
  load: () => api.get('/kid/activity?limit=30'),
  render: (page) => {
    const list = filteredActivity({
      view: 'kid',
      first: page,
      emptyText: 'When you get, spend or save money it shows up here.',
      fetchPage: (before, query) => api.get(`/kid/activity?limit=30${before ? `&before=${before}` : ''}${query}`),
    });
    return h(
      'div',
      { class: 'stack-lg' },
      h('header', { class: 'page-head', style: { marginBottom: '0' } }, h('div', null, h('h1', null, 'My activity'), h('p', null, 'Everything that’s happened with your money.'))),
      list.el,
    );
  },
});
