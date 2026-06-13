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
      "Fun YCH I thought would be cute for these two. It's no secret that Saphero's on the smaller side when it comes to most Espeon; he's always been shorter than Kloud, and evolution only made that difference more dramatic.",
      "Kloud loves it.",
      "After a long day of teasing his kitty, poking those glasses, and nudging Saphero away from his books, Kloud's last stop of the day lands them at a photo booth. Some friendships are made to be captured on camera~",
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
    num:   12,
    title: "Solus's Picture Day",
    prev:  'images/gallery/soluscheese_12prev.png',
    src:   'images/gallery/soluscheese_12.png',
    desc: [
      '"Show the cameras those fangs, buddy. Don\'t be shy."',
      "You won't find a picture of Solus without him grinning. Just how the cookie crumbles. (This is the best reference for the buppy~ notice the blue eyes and squishable cheeks)",
    ],
    credit: { name: 'StarBrightFur', url: 'https://x.com/StarBrightFur', platform: 'on Twitter ⭐️' },
    cat:   'art',
  },
  {
    num:   13,
    title: 'Bath Time With Pixern',
    prev:  'images/gallery/pixernbath_13prev.png',
    src:   'images/gallery/pixernbath_13.png',
    desc: [
      "After a taxing night, what better way to decompress than a bubble bath?",
    ],
    credit: { name: 'Shakalann', url: 'https://www.furaffinity.net/user/shakalann/', platform: 'on Furaffinity 🎨' },
    cat:   'art',
  },
  {
    num:   14,
    title: "Saphero's Library",
    prev:  'images/gallery/sciencesaphie_14prev.png',
    src:   'images/gallery/sciencesaphie_14.png',
    desc: [
      "AU anthro Saphero where he's your science professor prepping you for tomorrow's exam.",
      "No, there are no multiple choice :)",
    ],
    credit: { name: 'StarBrightFur', url: 'https://x.com/StarBrightFur', platform: 'on Twitter ⭐️' },
    cat:   'art',
  },
  {
    num:   15,
    title: 'Under the Moon',
    prev:  'images/gallery/citylightsklaphy_15prev.png',
    src:   'images/gallery/citylightsklaphy_15.jpg',
    desc: [
      "Was the old cover for the book, believe it or not~ This piece will always be special to me. I have a soft spot for Klaphy art, and this depiction captures their trust/friendship perfectly. Beyond the ~~totally not yaoi~~ tension, their relationship still blooms brighter than ever.",
    ],
    credit: { name: 'weshalbart', url: 'https://x.com/weshalbart', platform: 'on Twitter' },
    cat:   'art',
  },
  {
    num:   16,
    title: 'Your Eyes',
    prev:  'images/gallery/klaphyicon_16prev.png',
    src:   'images/gallery/klaphyicon_16.png',
    desc: [
      "THE FIRST EVER KLOUD AND SAPHERO ART! A close friend of mine gifted this early on, and it remains one of my favorite pieces ever made~",
      "At the time, I wasn't sure what eye colors Kloud/Saphero had, nor if Saphero wore his nerd glasses... but at its core, this piece will always be an ultimate icon for these two :3",
    ],
    credit: { name: 'liligabby21', url: 'https://bsky.app/profile/liligabby21.bsky.social', platform: 'on BlueSky 💙' },
    cat:   'art',
  },
  {
    num:   17,
    title: "Solus 'N Garnet Adventure",
    prev:  'images/gallery/solusgarnet_17prev.png',
    src:   'images/gallery/solusgarnet_17.png',
    desc: [
      "AU piece featuring Solus and a friend's character: Garnet. This, too, was made early on before I learned that Solus's eyes would be blue, but the piece is so gorgeous~",
      "I imagine an adventure with Solus consists of cotton candy, tail-pulling, and lots, lots of sore shoulders. But what's joy without a little sacrifice?",
    ],
    credit: { name: 'liligabby21', url: 'https://bsky.app/profile/liligabby21.bsky.social', platform: 'on BlueSky 💙' },
    cat:   'art',
  },

  // ── Spicy ────────────────────────────────────────────────────────
  // Numbered from 201 to stay separate from art + sketch IDs
  {
    num:     201,
    title:   'A Little Distracted~',
    prev:    'images/spicy/kloudthinking_1prev.png',
    src:     'images/spicy/kloudthinking_1.png',
    desc: [
      "There's something special about chatting with Saphero. Makes you wanna lay back, close your eyes, and imagine that cute face for a while~",
      "Kloud may be a little late. 💀",
    ],
    credit: { name: 'pechafruit', url: 'https://x.com/pechafruit', platform: 'on Twitter 🩷', gifted: true },
    cat:     'spicy',
  },
  {
    num:     202,
    title:   'Late-Night Bar Experience',
    prev:    'images/spicy/saphiebar_2prev.png',
    src:     'images/spicy/saphiebar_2.webp',
    desc: [
      "Cute AU depiction made yet again by the amazing Pechafruit! In this scene, I imagine Saphero meeting Kloud for the first time at a bar, and things heat up from there~",
      "I love how fun-sized Saphero looks here. He's a shy boy, but the right Umbreon can whisk him into a night he'll never forget.",
    ],
    credit: { name: 'pechafruit', url: 'https://x.com/pechafruit', platform: 'on Twitter 🩷', gifted: true },
    cat:     'spicy',
  },

  // ── Sketches ─────────────────────────────────────────────────────
  // Numbered from 101 to stay separate from art IDs
  {
    num:     101,
    title:   '"Take a Look~"',
    prev:    'images/sketches/lookatthis_1prev.png',
    src:     'images/sketches/lookatthis_1.png',
    desc: [
      "Silly sketch of Pixie and Solus :3 I need to get more art of these two. I imagine she's showing Solus the equivalent of Cocomelon in the BTW universe 💀 (Buppy is about 10 or so here~)",
    ],
    credit: { name: 'pechafruit', url: 'https://x.com/pechafruit', platform: '🩷', gifted: true },
    cat:     'sketches',
  },
  {
    num:     102,
    title:   'Nerd Glasses',
    prev:    'images/sketches/saphiesketch_2prev.png',
    src:     'images/sketches/saphiesketch_2.png',
    desc: [
      "He can't read without them 🐱",
    ],
    credit: { name: 'liligabby21', url: 'https://bsky.app/profile/liligabby21.bsky.social', platform: 'on BlueSky 💙' },
    cat:     'sketches',
  },
  {
    num:     103,
    title:   'Poppy and Dante',
    prev:    'images/sketches/dantepoppycute_3prev.png',
    src:     'images/sketches/dantepoppycute_3.png',
    desc: [
      "At the factory, he's shut off, gruff, and candid. But when he gets back home and finds those eyes, his world lightens up.",
      "Poppy is the anchor of Dante's life. For her, he'd sacrifice everything... (ooo ominous story foreshadowing~ go read it now!)",
    ],
    credit: { name: 'liligabby21', url: 'https://bsky.app/profile/liligabby21.bsky.social', platform: 'on BlueSky 💙' },
    cat:     'sketches',
  },
  {
    num:     104,
    title:   'Date Night',
    prev:    'images/sketches/cafedate_4prev.png',
    src:     'images/sketches/cafedate_4.png',
    desc: [
      "Every time Pixie and Inferno go out to eat, they share a meal. Soup, salad, dessert — one plate is all they need! ^w^",
      { html: 'Fun fact: this sketch features a close friend of mine\'s characters: BlueStrike. Check out <a href="https://www.wattpad.com/1512548895-above-all-else-lucario-x-zoroark-pok%C3%A9mon-prologue" target="_blank" rel="noopener">Above All Else</a> if you want a great pokéfic.' },
      "Specifically, the Zoroark and Lucario in the other booth, as well as the Leafeon carrying the microscopic Espy belong to him. A nice union of our chars~",
    ],
    credit: { name: 'pechafruit', url: 'https://x.com/pechafruit', platform: '🩷', gifted: true },
    cat:     'sketches',
  },
];
