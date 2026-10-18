import { h } from '../../dom.js';
import { icon } from '../../icons.js';
import { defineView } from '../../view.js';

const ITEMS = [
  ['#/activity', 'list', 'Activity', 'Every dollar in and out'],
  ['#/insights', 'trend', 'Insights', 'Spending, saving and earning'],
  ['#/funding', 'wallet', 'Funding', 'Add funds · cards coming soon'],
  ['#/settings', 'sliders', 'Settings', 'Profile, password, appearance'],
];

export const moreView = defineView({
  title: 'More',
  load: async () => ({}),
  render: () =>
    h(
      'div',
      { class: 'stack-lg' },
      h('header', { class: 'page-head', style: { marginBottom: '0' } }, h('div', null, h('h1', null, 'More'))),
      h('div', { class: 'card card-flush more-list' }, ITEMS.map(([href, ic, title, sub]) => h('a', { href }, h('span', { class: 'icon-wrap' }, icon(ic, 21)), h('span', { class: 'grow' }, h('div', null, title), h('div', { class: 'small muted', style: { fontWeight: 500 } }, sub)), icon('right', 18)))),
    ),
});
