// Runs before first paint (a classic script in <head>) so the chosen theme and text size never flash the wrong way.
try {
  var root = document.documentElement;
  var t = localStorage.getItem('nestly-theme');
  if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
  if (localStorage.getItem('nestly-text') === 'large') root.setAttribute('data-text', 'large');
  if (localStorage.getItem('nestly-motion') === 'reduce') root.setAttribute('data-motion', 'reduce');
} catch (e) {}
