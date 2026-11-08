import { h, setBusy } from '../../dom.js';
import { icon } from '../../icons.js';
import { api } from '../../api.js';
import { defineView } from '../../view.js';
import { state, changePasswordDialog } from '../../shell.js';
import { toast, textField } from '../../ui.js';
import { rulesCard, displayCard, devicesCard, dataCard } from './account.js';

export const settingsView = defineView({
  title: 'Settings',
  load: async () => {
    const [me, rules] = await Promise.all([api.get('/me'), api.get('/rules')]);
    return { ...me, ...rules };
  },
  render: ({ user, rules }) => {
    const name = textField({ label: 'Your name', value: user.name, maxlength: 60 });
    const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [user.timezone];
    if (!zones.includes(user.timezone)) zones.unshift(user.timezone);
    const tz = h('select', { class: 'select', id: 'tz' }, zones.map((z) => h('option', { value: z, selected: z === user.timezone }, z.replace(/_/g, ' '))));
    const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save changes');
    const form = h('form', { class: 'stack', novalidate: true },
      name.el,
      h('div', { class: 'field' }, h('label', { for: 'tz' }, 'Time zone'), tz, h('div', { class: 'hint' }, 'Allowances are paid at the start of your day in this time zone.')),
      h('div', null, save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      setBusy(save, true);
      try {
        const r = await api.patch('/me', { name: name.input.value, timezone: tz.value });
        state.user = r.user;
        toast('Settings saved');
      } catch (err) {
        toast(err.message, { tone: 'error' });
      } finally {
        setBusy(save, false);
      }
    });
    if ((location.hash.split('?')[1] ?? '').includes('focus=rules')) setTimeout(() => document.getElementById('rules')?.scrollIntoView({ block: 'start' }), 60);
    return h('div', { class: 'stack-lg', style: { maxWidth: '640px' } },
      h('header', { class: 'page-head', style: { marginBottom: '0' } }, h('div', null, h('h1', null, 'Settings'), h('p', null, user.email))),
      h('section', { class: 'card' }, h('h2', { class: 'card-title', style: { marginBottom: '16px' } }, 'Profile'), form),
      rulesCard({ rules }),
      displayCard(),
      h('section', { class: 'card' }, h('div', { class: 'control' }, h('div', null, h('b', null, 'Password'), h('div', { class: 'desc' }, 'Changing it signs you out on other devices.')), h('button', { class: 'btn btn-sm', onClick: () => changePasswordDialog(user) }, icon('key', 16), 'Change'))),
      devicesCard(),
      dataCard(user),
      h('section', { class: 'card' }, h('h2', { class: 'card-title' }, 'About practice money'), h('p', { class: 'text-2', style: { marginTop: '8px' } }, 'Nestly is currently a practice bank: balances are play money and nothing here is connected to a real bank account or card. Linking real cards is coming later.')));
  },
});
