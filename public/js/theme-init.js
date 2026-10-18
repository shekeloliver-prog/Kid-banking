// Runs before first paint (a classic script in <head>) so the chosen theme never flashes the wrong colours.
try {
  var t = localStorage.getItem('nestly-theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) {}
