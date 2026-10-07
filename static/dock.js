(() => {
  'use strict';

  const dock = document.querySelector('.app-dock');
  const items = [...dock.querySelectorAll('[data-app]')];

  function select(name) {
    items.forEach((item) => {
      const active = item.dataset.app === name;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', String(active));
    });
  }

  const gameLabels = new Set(['Games', 'Simon', 'Difference', 'Scramble', 'Multi']);

  items.forEach((item) => item.addEventListener('click', () => {
    const app = item.dataset.app;
    select(app);

    if (app === 'ask') {
      Win.close();
      document.getElementById('orb').focus({preventScroll: true});
    } else if (app === 'weather') {
      Weather.open().then((data) => { if (!data) select('ask'); });
    } else if (app === 'games') {
      Games.openMenu();
    } else if (app === 'calendar') {
      CalendarApp.open();
    } else if (app === 'messages') {
      Messages.open();
    } else if (app === 'medora') {
      Medora.open();
    } else if (app === 'news') {
      News.open();
    }
  }));

  window.addEventListener('winchange', (event) => {
    const label = event.detail && event.detail.label;
    if (!label) select('ask');
    else if (label === 'Weather') select('weather');
    else if (label === 'Calendar') select('calendar');
    else if (label === 'Messages') select('messages');
    else if (label === 'Medora') select('medora');
    else if (label === 'News') select('news');
    else if (gameLabels.has(label)) select('games');
  });
})();
