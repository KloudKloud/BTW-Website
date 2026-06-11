/*
  ── GALLERY DATA ────────────────────────────────────────────────────
  Add one entry per artwork. Fields:
    num     – chronological order (controls sort; must be unique)
    title   – display title shown on the artwork's page
    prev    – path to the preview/thumbnail image
    src     – path to the full-size image
    caption – short description (optional)
    cat     – category: "art" | "sketches"
  ────────────────────────────────────────────────────────────────────
*/
const GALLERY = [
  {
    num:     1,
    title:   'Kloud & Saph — Bedroom',
    prev:    'images/gallery/kloudsaphbedroom_1prev.png',
    src:     'images/gallery/kloudsaphbedroom_1.png',
    caption: '',
    cat:     'art',
  },
  {
    num:     2,
    title:   'Pixer — Nice Cream',
    prev:    'images/gallery/pixernicecream_2prev.png',
    src:     'images/gallery/pixernicecream_2.png',
    caption: '',
    cat:     'art',
  },
  {
    num:     3,
    title:   'Drowning',
    prev:    'images/gallery/drowning_3prev.png',
    src:     'images/gallery/drowning_3.png',
    caption: '',
    cat:     'art',
  },
  {
    num:     4,
    title:   'Sleepytime',
    prev:    'images/gallery/sleepytime_prev4.png',
    src:     'images/gallery/sleepytime_4.png',
    caption: '',
    cat:     'art',
  },
  {
    num:     5,
    title:   'Pixie — Garden',
    prev:    'images/gallery/pixiegarden_5prev.png',
    src:     'images/gallery/pixiegarden_5.png',
    caption: '',
    cat:     'art',
  },
  {
    num:     6,
    title:   'Close',
    prev:    'images/gallery/close_6prev.png',
    src:     'images/gallery/close_6.png',
    caption: '',
    cat:     'art',
  },
  {
    num:     7,
    title:   'Kloud — Selfie',
    prev:    'images/gallery/kloudselfie_7prev.png',
    src:     'images/gallery/kloudselfie_7.png',
    caption: '',
    cat:     'art',
  },
  {
    num:     8,
    title:   'Inferno — Selfie',
    prev:    'images/gallery/infernoselfie_8prev.png',
    src:     'images/gallery/infernoselfie_8.png',
    caption: '',
    cat:     'art',
  },
  {
    num:     9,
    title:   'Klaphy — Selfie',
    prev:    'images/gallery/klaphyselfie_9prev.png',
    src:     'images/gallery/klaphyselfie_9.png',
    caption: '',
    cat:     'art',
  },
  {
    num:     10,
    title:   'Apollo — Reference',
    prev:    'images/gallery/apolloref_10prev.png',
    src:     'images/gallery/apolloref_10.png',
    caption: '',
    cat:     'art',
  },
  {
    num:     11,
    title:   'Autumn Leaves',
    prev:    'images/gallery/autumnleaves_11prev.png',
    src:     'images/gallery/autumnleave_11.png',
    caption: '',
    cat:     'art',
  },
  {
    num:     12,
    title:   'Solus — Cheese',
    prev:    'images/gallery/soluscheese_12prev.png',
    src:     'images/gallery/soluscheese_12.png',
    caption: '',
    cat:     'art',
  },
  {
    num:     13,
    title:   'Pixer — Bath',
    prev:    'images/gallery/pixernbath_13prev.png',
    src:     'images/gallery/pixernbath_13.png',
    caption: '',
    cat:     'art',
  },
  {
    num:     14,
    title:   'Science — Saphie',
    prev:    'images/gallery/sciencesaphie_14prev.png',
    src:     'images/gallery/sciencesaphie_14.png',
    caption: '',
    cat:     'art',
  },
  {
    num:     15,
    title:   'City Lights — Klaphy',
    prev:    'images/gallery/citylightsklaphy_15prev.png',
    src:     'images/gallery/citylightsklaphy_15.jpg',
    caption: '',
    cat:     'art',
  },
  {
    num:     16,
    title:   'Klaphy — Icon',
    prev:    'images/gallery/klaphyicon_16prev.png',
    src:     'images/gallery/klaphyicon_16.png',
    caption: '',
    cat:     'art',
  },
  {
    num:     17,
    title:   'Solus — Garnet',
    prev:    'images/gallery/solusgarnet_17prev.png',
    src:     'images/gallery/solusgarnet_17.png',
    caption: '',
    cat:     'art',
  },

  // ── Spicy ────────────────────────────────────────────────────────
  // Numbered from 201 to stay separate from art + sketch IDs
  {
    num:     201,
    title:   'Kloud — Thinking',
    prev:    'images/spicy/kloudthinking_1prev.png',
    src:     'images/spicy/kloudthinking_1.png',
    caption: '',
    cat:     'spicy',
  },
  {
    num:     202,
    title:   'Saphie — Bar',
    prev:    'images/spicy/saphiebar_2prev.png',
    src:     'images/spicy/saphiebar_2.webp',
    caption: '',
    cat:     'spicy',
  },

  // ── Sketches ─────────────────────────────────────────────────────
  // Numbered from 101 to stay separate from art IDs
  {
    num:     101,
    title:   'Look at This',
    prev:    'images/sketches/lookatthis_1prev.png',
    src:     'images/sketches/lookatthis_1.png',
    caption: '',
    cat:     'sketches',
  },
  {
    num:     102,
    title:   'Saphie — Sketch',
    prev:    'images/sketches/saphiesketch_2prev.png',
    src:     'images/sketches/saphiesketch_2.png',
    caption: '',
    cat:     'sketches',
  },
  {
    num:     103,
    title:   'Dante & Poppy — Cute',
    prev:    'images/sketches/dantepoppycute_3prev.png',
    src:     'images/sketches/dantepoppycute_3.png',
    caption: '',
    cat:     'sketches',
  },
  {
    num:     104,
    title:   'Cafe Date',
    prev:    'images/sketches/cafedate_4prev.png',
    src:     'images/sketches/cafedate_4.png',
    caption: '',
    cat:     'sketches',
  },
];
