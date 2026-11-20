/* Platform: which keyboard and window chrome to draw (G2).
   App commands use cmd on a Mac and ctrl on Windows. Vim's own ctrl keys (ctrl-o, ctrl-i, ctrl-w, ctrl-n/p
   in lists) and the leader are ctrl on both. option / alt + h j k l are read by physical key (e.code),
   because option-h types ˙ on a Mac. ?os=mac|win overrides the guess. */
(function () {
  const q = new URLSearchParams(location.search).get('os') || ({ '#mac': 'mac', '#win': 'win' })[location.hash];
  const OS = window.OS = q === 'mac' || q === 'win' ? q : (/Mac/i.test(navigator.platform) ? 'mac' : 'win');
  // a key as this OS writes it: kb('mod-shift-a') is ⌘⇧A on a Mac and ctrl-shift-a on Windows
  window.kb = str => str.split(' ').map(x => {
    if (OS !== 'mac') return x.replace(/(^|-)mod-/, '$1ctrl-');
    const ps = x.split('-'); if (ps.length < 2 || x === '-') return x;
    const G = { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' }, key = ps.pop();
    return ps.every(m => G[m]) ? ps.map(m => G[m]).join('') + (key === 'space' ? 'Space' : key === 'tab' ? 'Tab' : key.toUpperCase()) : x;
  }).join(' ');
})();
