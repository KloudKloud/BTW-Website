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
    num:   1,
    title: 'Sleepy Saphy',
    prev:  'images/gallery/kloudsaphbedroom_1prev.png',
    src:   'images/gallery/kloudsaphbedroom_1.png',
    desc: [
      "I like to envision that Kloud's chest is a pillow for Saphero whenever they have sleepovers (every other night). Kloud prefers big spooning, but this will also suffice~",
      "Poor kitty was so eepy he forgot to take his glasses off ;w;",
    ],
    credit: { name: 'ief_Cuadricula', url: 'https://x.com/ief_Cuadricula', platform: 'on Twitter~ 🎨' },
    cat:   'art',
  },
  {
    num:   2,
    title: 'Pixie and Inferno Ice Cream Date',
    prev:  'images/gallery/pixernicecream_2prev.png',
    src:   'images/gallery/pixernicecream_2.png',
    desc: [
      "Love comes in all shapes, sizes, and flavors. Somewhere off the coast of Lotus Falls, two pokémon admire the waves crashing, ribbons and talons connected. Pixie and Inferno never find the right words to say, but tonight, they don't need them.",
    ],
    credit: { name: 'Shakalann', url: 'https://www.furaffinity.net/user/shakalann/', platform: 'on Furaffinity 🎨' },
    cat:   'art',
  },
  {
    num:   3,
    title: '"Stay With Me"',
    prev:  'images/gallery/drowning_3prev.png',
    src:   'images/gallery/drowning_3.png',
    desc: [
      "This piece depicts a scene from the story. When the world sinks around him, only one pup can pull him back to shore.",
    ],
    credit: { name: 'ief_Cuadricula', url: 'https://x.com/ief_Cuadricula', platform: 'on Twitter 🌸' },
    cat:   'art',
  },
  {
    num:   4,
    title: 'Solus Bedtime Pets',
    prev:  'images/gallery/sleepytime_prev4.png',
    src:   'images/gallery/sleepytime_4.png',
    desc: [
      "Brush fangs, warm milk, and a kiss goodnight from Inferno. The three bedtime rituals all growing bups need. Tomorrow's a new adventure, but the pillow comes first.",
    ],
    credit: { name: 'Shakalann', url: 'https://www.furaffinity.net/user/shakalann/', platform: 'on Furaffinity 🎨' },
    cat:   'art',
  },
  {
    num:   5,
    title: 'Pixie Sprawling in the Garden',
    prev:  'images/gallery/pixiegarden_5prev.png',
    src:   'images/gallery/pixiegarden_5.png',
    desc: [
      "The note in her ribbons is a love letter from Inferno :3 I imagine between sets, Pixie sneaks off for a few private shoots. Most of her photos are for the world to see, but some special, quiet galleries are exclusively for her Blaziken's eyes~",
    ],
    credit: { name: 'StarBrightFur', url: 'https://x.com/StarBrightFur', platform: '⭐️' },
    cat:   'art',
  },
  {
    num:   6,
    title: '"Let Me Hold You"',
    prev:  'images/gallery/close_6prev.png',
    src:   'images/gallery/close_6.png',
    desc: [
      "This is another scene from the book ^w^ The first ever art I got of Inferno and Pixie, actually~ (AND RAHHH, I LOVE IT SO MUCH!) I like to imagine them laying down together, eye-to-eye, as symbolic for how love transcends boundaries.",
      "Despite how different their species are, or what people say about them, when they curl up in bed and hold each other close, the rest of the world fades.",
    ],
    credit: { name: 'Shakalann', url: 'https://www.furaffinity.net/user/shakalann/', platform: 'on Furaffinity 🎨' },
    cat:   'art',
  },
  {
    num:   7,
    title: 'Kloud Being Kloud',
    prev:  'images/gallery/kloudselfie_7prev.png',
    src:   'images/gallery/kloudselfie_7.png',
    desc: [
      "This is the official reference for Kloud. With a knack for trouble, chaos, and cracking jokes at the expense of his nerd (Saphero), this tough 'bre prefers life on the edge~",
      "And of course, what's life without a little fun? (The amulet, in canon, was passed down from his father, and the card in his maw represents his persona pretty well I'd say)",
    ],
    credit: { name: 'StarBrightFur', url: 'https://x.com/StarBrightFur', platform: '⭐️' },
    cat:   'art',
  },
  {
    num:   8,
    title: 'Inferno Starstorm',
    prev:  'images/gallery/infernoselfie_8prev.png',
    src:   'images/gallery/infernoselfie_8.png',
    desc: [
      "I love this piece. It's a great reference for Inferno and his detective cloak, and the little Riolu plush symbolizes the gremlin he cherishes most. He has long talks with Solus about stars, exploring, and finding your own journey in life...",
      "But his own adventure is just beginning.",
    ],
    credit: { name: 'StarBrightFur', url: 'https://x.com/StarBrightFur', platform: '⭐️' },
    cat:   'art',
  },
  {
    num:   9,
    title: 'Selfie W/The Besties',
    prev:  'images/gallery/klaphyselfie_9prev.png',
    src:   'images/gallery/klaphyselfie_9.png',
    desc: [
      "Fun YCH I thought would be cute for these two. It's no secret that Saphero's on the smaller side when it comes to Espeon; he's always been shorter than Kloud, and evolution only made their difference more dramatic.",
      "Kloud loves it.",
      "After a long day of teasing his kitty, poking those glasses, and nudging Saphero away from his books, Kloud's last stop of the day is a photo booth. Some friendships are made to be captured on camera~",
    ],
    credit: { name: 'trendsetter', url: 'https://www.furaffinity.net/user/trendsetter/', platform: 'on Furaffinity 🎨' },
    cat:   'art',
  },
  {
    num:   10,
    title: 'With Great Power...',
    prev:  'images/gallery/apolloref_10prev.png',
    src:   'images/gallery/apolloref_10.png',
    desc: [
      "For the past decade, Galena Collis has entrusted Apollo as its sworn protector. Every leader watches over a celestial dragon, and this piece depicts some of that power.",
      "Whenever I created magic in my universe, I wanted Apollo's to feel special. He's the no-nonsense, justice-first Delcatty...",
      "...",
      "And deep down, there's a little bit of Dad inside that core~",
    ],
    credit: { name: 'StarBrightFur', url: 'https://x.com/StarBrightFur', platform: 'on Twitter 🎨' },
    cat:   'art',
  },
  {
    num:   11,
    title: 'Solus Playing in the Leaves',
    prev:  'images/gallery/autumnleaves_11prev.png',
    src:   'images/gallery/autumnleave_11.png',
    desc: [
      "This piece was a cute YCH I thought fit Solus~ I don't typically imagine my characters in clothes, but I can totally see Inferno dressing him in a robe/jacket to play outside one day :3",
    ],
    credit: { name: 'AleskiSam', url: 'https://x.com/AleskiSam', platform: 'on Twitter' },
    cat:   'art',
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
