// Photo carousels (portfolio), film reels (adventure) and one shared lightbox.
// Markup: .car > .car-track > img...   |   .reel > .reel-track > img...   (data-title on the wrapper)
// Click any photo to open it large; arrows, swipe, and keyboard (left/right/Esc) move through the set.
(function () {
  const lb = document.getElementById('lightbox');
  const lbImg = lb.querySelector('img'), lbCap = lb.querySelector('.lb-cap'), lbCount = lb.querySelector('.lb-count');
  let set = [], at = 0, title = '';

  function show(i) {
    at = (i + set.length) % set.length;
    const im = set[at];
    lbImg.src = im.currentSrc || im.src; lbImg.alt = im.alt;
    lbCap.textContent = title;
    lbCount.textContent = set.length > 1 ? `${at + 1} / ${set.length}` : '';
    lb.classList.toggle('single', set.length < 2);
  }
  function open(group, i) {
    set = [...group.querySelectorAll('img')]; title = group.dataset.title || '';
    show(i); lb.showModal();
  }
  lb.querySelector('.lb-prev').onclick = () => show(at - 1);
  lb.querySelector('.lb-next').onclick = () => show(at + 1);
  lb.querySelector('.lb-close').onclick = () => lb.close();
  lb.addEventListener('click', (e) => { if (e.target === lb) lb.close(); }); // click outside the photo
  lb.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') show(at - 1); if (e.key === 'ArrowRight') show(at + 1); });
  let sx = null;
  lb.addEventListener('pointerdown', (e) => { sx = e.clientX; });
  lb.addEventListener('pointerup', (e) => { if (sx !== null && Math.abs(e.clientX - sx) > 50) show(at + (e.clientX < sx ? 1 : -1)); sx = null; });

  // Carousels: one photo at a time, arrows + counter, click to enlarge
  document.querySelectorAll('.car').forEach((car) => {
    const track = car.querySelector('.car-track'), imgs = [...track.querySelectorAll('img')];
    const count = car.querySelector('.car-count');
    let i = 0;
    const go = (n) => { i = (n + imgs.length) % imgs.length; track.style.transform = `translateX(${-100 * i}%)`; if (count) count.textContent = `${i + 1} / ${imgs.length}`; };
    if (imgs.length < 2) car.classList.add('single');
    car.querySelector('.car-prev')?.addEventListener('click', (e) => { e.stopPropagation(); go(i - 1); });
    car.querySelector('.car-next')?.addEventListener('click', (e) => { e.stopPropagation(); go(i + 1); });
    track.addEventListener('click', () => open(car, i));
    car.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(car, i); if (e.key === 'ArrowLeft') go(i - 1); if (e.key === 'ArrowRight') go(i + 1); });
    go(0);
  });

  // Film reels: scroll sideways, arrows page through, click a frame to enlarge
  document.querySelectorAll('.reel').forEach((reel) => {
    const track = reel.querySelector('.reel-track');
    const page = (d) => track.scrollBy({ left: d * track.clientWidth * 0.8, behavior: 'smooth' });
    reel.querySelector('.reel-prev').onclick = () => page(-1);
    reel.querySelector('.reel-next').onclick = () => page(1);
    track.querySelectorAll('img').forEach((im, n) => {
      im.tabIndex = 0;
      im.addEventListener('click', () => open(reel, n));
      im.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(reel, n); });
    });
  });
})();
