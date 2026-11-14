'use strict';

const controls = document.querySelector('[data-controls]');
const buttons = [...controls.querySelectorAll('button')];
const search = controls.querySelector('input');
const cards = [...document.querySelectorAll('.plugin-card')];
const count = document.querySelector('[data-count]');
const empty = document.querySelector('[data-empty]');
const all = buttons[0];
let selected = all;

function filter() {
  const words = search.value.trim().toLowerCase().split(/\s+/);
  let visible = 0;
  for (const card of cards) {
    const categoryMatches = selected === all || card.dataset.category === selected.textContent;
    const textMatches = words.every(word => card.dataset.search.includes(word));
    card.hidden = !(categoryMatches && textMatches);
    if (!card.hidden) visible++;
  }
  count.textContent = `${visible} ${visible === 1 ? 'plugin' : 'plugins'}`;
  empty.hidden = visible > 0;
}

function select(button) {
  selected.setAttribute('aria-pressed', 'false');
  selected = button;
  selected.setAttribute('aria-pressed', 'true');
  filter();
}

for (const button of buttons) {
  button.addEventListener('click', () => select(button));
}
search.addEventListener('input', filter);
document.querySelector('[data-clear]').addEventListener('click', () => {
  search.value = '';
  select(all);
  search.focus();
});
controls.hidden = false;
filter();
