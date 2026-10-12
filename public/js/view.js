import { h } from './dom.js';
import { skeleton, errorState } from './ui.js';

/**
 * A page = load() the data, render(data) the DOM. refresh() re-runs both in place, keeping scroll.
 * `autoRefresh` pages quietly reload when new notifications arrive.
 */
export function defineView({ title, load, render, autoRefresh = false }) {
  return (params) => {
    const root = h('div', { class: 'view' });
    let loaded = false;
    async function refresh({ silent = false } = {}) {
      if (!loaded && !silent) root.replaceChildren(skeleton());
      try {
        const data = await load(params);
        const y = window.scrollY;
        root.replaceChildren(render(data, { refresh, params }));
        loaded = true;
        if (silent) window.scrollTo(0, y);
        if (typeof title === 'function') document.title = `${title(data)} · Nestly`;
      } catch (err) {
        if (err.status === 401) return;
        root.replaceChildren(errorState(err, () => refresh()));
      }
    }
    if (typeof title === 'string') document.title = `${title} · Nestly`;
    refresh();
    return { el: root, refresh, autoRefresh };
  };
}
