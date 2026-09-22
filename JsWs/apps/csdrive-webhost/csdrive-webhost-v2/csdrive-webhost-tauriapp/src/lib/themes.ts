/** The app's themes: the colours of every page of the admin-app and of the system apps (Notes...), light and dark.
 *
 * A theme is a name and two palettes — one for a light appearance and one for a dark one — of the few colours the styles
 * (`App.css`) are written in as CSS variables. Choosing a theme and whether the appearance is light, dark or the device's
 * own is done in the admin-app's Settings and kept by the backend for the whole app (`appearance.rs`); every page applies it
 * with `applyAppearance` (`lib/appearance.ts`). The Rust side only knows the *id* of the theme — this catalog is the frontend's,
 * so a theme can be added or renamed without touching it (an id it doesn't know falls back to the default). */

export interface Palette {
  bg: string
  fg: string
  muted: string
  border: string
  accent: string
  /** The text on an accent-coloured button. */
  accentFg: string
  /** Panels, headers, the tinted area of a list. */
  panel: string
  hover: string
}

export interface Theme {
  id: string
  name: string
  family: string
  light: Palette
  dark: Palette
}

export const DEFAULT_THEME = 'ayran-orange'

/** The colours that don't change with the theme's mood: what says "error" or "done", and the syntax colours of the editor. */
const SIGNALS = {
  light: {
    'error-bg': '#fee2e2',
    'error-fg': '#991b1b',
    'status-bg': '#dcfce7',
    'status-fg': '#166534',
    'tok-quote': '#6b7280',
    'tok-list': '#be185d',
    'tok-code': '#b45309',
    'tok-url': '#0e7490',
    'tok-tag': '#15803d',
    'tok-attr': '#b45309',
    'tok-string': '#0f766e',
    'tok-entity': '#7c3aed',
    'tok-quiet': '#6b7280',
  },
  dark: {
    'error-bg': '#3f1d1d',
    'error-fg': '#fca5a5',
    'status-bg': '#14301f',
    'status-fg': '#86efac',
    'tok-quote': '#9ca3af',
    'tok-list': '#f9a8d4',
    'tok-code': '#fbbf24',
    'tok-url': '#67e8f9',
    'tok-tag': '#86efac',
    'tok-attr': '#fdba74',
    'tok-string': '#5eead4',
    'tok-entity': '#c4b5fd',
    'tok-quiet': '#9ca3af',
  },
} as const

const p = (bg: string, fg: string, muted: string, border: string, accent: string, accentFg: string, panel: string, hover: string): Palette => ({
  bg,
  fg,
  muted,
  border,
  accent,
  accentFg,
  panel,
  hover,
})

const theme = (id: string, name: string, family: string, light: Palette, dark: Palette): Theme => ({ id, name, family, light, dark })

export const FAMILIES = [
  'The app',
  'Hot desert',
  'Scorching earth',
  'Tropical volcanoes',
  'Sunny autumn',
  'Rainy autumn',
  'Misty swamps',
  'Snow and mist',
  'Clay, rust and copper',
  'Coffee and chocolate',
  'Wood',
  'Metals',
  'Jewel tones',
  'Teal and seaweed',
  'Green forest',
  'Blue',
  'Steel blue',
  'Mars',
] as const

export const THEMES: Theme[] = [
  // ── The app's own ──
  theme('ayran-orange', 'Ayran orange', 'The app',
    p('#ffffff', '#1a1a1a', '#6b7280', '#e2e8f0', '#d04a0b', '#ffffff', '#f8fafc', '#f1f5f9'),
    p('#16181d', '#e5e7eb', '#9ca3af', '#30343c', '#fb923c', '#0b0d10', '#1c1f26', '#20242c')),
  theme('classic-blue', 'Classic blue', 'The app',
    p('#ffffff', '#1a1a1a', '#6b7280', '#e2e8f0', '#2563eb', '#ffffff', '#f8fafc', '#f1f5f9'),
    p('#16181d', '#e5e7eb', '#9ca3af', '#30343c', '#3b82f6', '#0b0d10', '#1c1f26', '#20242c')),

  // ── Hot desert: sand, noon light, red rock ──
  theme('dune-noon', 'Dune noon', 'Hot desert',
    p('#fbf1dc', '#3a2a14', '#8a6d47', '#e6cfa3', '#c2571a', '#ffffff', '#f5e4c1', '#f0dcb2'),
    p('#2a1d10', '#f3e2c4', '#b99a6b', '#4a3620', '#e8823a', '#1e1206', '#34240f', '#3f2c15')),
  theme('mirage', 'Mirage', 'Hot desert',
    p('#fff7e8', '#40301f', '#9b8464', '#ecd9b4', '#d98e04', '#2b1b00', '#fdeccb', '#f9e2b8'),
    p('#1f1a14', '#f4e9d3', '#b8a684', '#443a2a', '#f2b134', '#231600', '#29221a', '#332a1f')),
  theme('sandstone-canyon', 'Sandstone canyon', 'Hot desert',
    p('#f6e6d8', '#3b2418', '#8d6a55', '#dfc0aa', '#b23a24', '#ffffff', '#efd5c1', '#e8cab3'),
    p('#2b1812', '#f2dccf', '#b8917c', '#4d2f24', '#e0684a', '#200d08', '#35201a', '#402920')),

  // ── Scorching earth: cracked clay, ember, ash ──
  theme('cracked-clay', 'Cracked clay', 'Scorching earth',
    p('#efe4d6', '#2f2218', '#7f6a56', '#d3bfa8', '#a3401c', '#ffffff', '#e6d6c2', '#ddcab3'),
    p('#211711', '#eadbc9', '#a89078', '#402e22', '#d2643a', '#1c0d06', '#2b1d15', '#35251b')),
  theme('ember-ash', 'Ember and ash', 'Scorching earth',
    p('#f0eae6', '#2a2320', '#7a6d66', '#d8cec8', '#d1361a', '#ffffff', '#e7dfda', '#ded4ce'),
    p('#171312', '#eae0db', '#a1918a', '#382d2a', '#ff5a36', '#1a0703', '#201a18', '#2a2321')),
  theme('sun-baked-ochre', 'Sun-baked ochre', 'Scorching earth',
    p('#f4e7c8', '#33280f', '#85703f', '#dfca90', '#8a6a00', '#ffffff', '#ecdcab', '#e4d29b'),
    p('#221b0b', '#f0e3bd', '#b2995a', '#453a1c', '#d9a520', '#1d1400', '#2c2410', '#362d15')),

  // ── Tropical volcanoes: jungle, lava, basalt and a warm sea ──
  theme('lava-jungle', 'Lava jungle', 'Tropical volcanoes',
    p('#eef6ee', '#16261a', '#557a5c', '#c6dfc9', '#d93f14', '#ffffff', '#e0eee2', '#d5e7d8'),
    p('#0f1a13', '#dff0e2', '#83a98b', '#22382a', '#ff6a3c', '#200a03', '#15231b', '#1b2c22')),
  theme('basalt-turquoise', 'Basalt and turquoise', 'Tropical volcanoes',
    p('#eaf4f4', '#142428', '#4f7a80', '#bfdcde', '#0b8676', '#ffffff', '#dceded', '#d0e5e6'),
    p('#0d1719', '#d9eeee', '#7fa9ad', '#203a3d', '#2fd1b8', '#05201b', '#122124', '#182b2f')),
  theme('orchid-caldera', 'Orchid caldera', 'Tropical volcanoes',
    p('#fbeef2', '#2a1420', '#8a5570', '#efcbd9', '#c2185b', '#ffffff', '#f6dfe8', '#f0d2df'),
    p('#1c0f16', '#f5dce6', '#b98099', '#3d2030', '#ff5c8d', '#2a0512', '#26151f', '#301c28')),

  // ── Sunny autumn: gold, maple, apple orchards ──
  theme('golden-maple', 'Golden maple', 'Sunny autumn',
    p('#fff6e3', '#3a2410', '#96703c', '#f0d9a8', '#d9480f', '#ffffff', '#fbe9c4', '#f7dfae'),
    p('#23170a', '#f6e6c8', '#c19a5a', '#48341a', '#f08a24', '#241202', '#2d1f0e', '#382714')),
  theme('harvest-gold', 'Harvest gold', 'Sunny autumn',
    p('#fbf5d8', '#35300f', '#8a8035', '#e9df9b', '#946a06', '#ffffff', '#f3ebbb', '#ece2ab'),
    p('#1f1d0a', '#f2ecc4', '#b9b06a', '#433f1a', '#e3b92b', '#201b00', '#292711', '#33301a')),
  theme('orchard-crimson', 'Orchard crimson', 'Sunny autumn',
    p('#fdf1ea', '#3a1a14', '#94604f', '#f0d0c1', '#b5301f', '#ffffff', '#f8e2d6', '#f3d6c7'),
    p('#23120e', '#f6ddd2', '#c08a78', '#48261f', '#ee6a4f', '#260a04', '#2d1a15', '#38221c')),

  // ── Rainy autumn: grey light, wet copper, fallen leaves ──
  theme('drizzle', 'Drizzle', 'Rainy autumn',
    p('#eceeed', '#23292b', '#6b767a', '#d3d9d9', '#b0601a', '#ffffff', '#e2e6e5', '#d9dedd'),
    p('#16191a', '#dfe4e4', '#8e9a9d', '#2b3234', '#d98a4a', '#1a0e04', '#1d2224', '#252b2d')),
  theme('wet-leaves', 'Wet leaves', 'Rainy autumn',
    p('#ebe8df', '#2a2618', '#756f55', '#d4cfba', '#8c5a1a', '#ffffff', '#e1ddcf', '#d8d3c2'),
    p('#191710', '#e3dfcc', '#9a9376', '#322f21', '#c9903a', '#1c1204', '#211f16', '#29271c')),
  theme('stormy-umber', 'Stormy umber', 'Rainy autumn',
    p('#e6e7ea', '#22242c', '#666b7a', '#cfd1d8', '#9a4a2a', '#ffffff', '#dcdee3', '#d2d5db'),
    p('#14161c', '#dcdfe8', '#8b91a3', '#282b35', '#d0774f', '#1e0d06', '#1b1e26', '#22262f')),

  // ── Misty swamps: green-grey water and fog ──
  theme('bog-mist', 'Bog mist', 'Misty swamps',
    p('#e9efe8', '#1e2a20', '#647a69', '#cfdccf', '#4d7c3a', '#ffffff', '#dfe8de', '#d4e0d3'),
    p('#121a14', '#d9e5db', '#859c8a', '#263329', '#79b35e', '#0c1a06', '#182219', '#1f2b21')),
  theme('cypress-fog', 'Cypress fog', 'Misty swamps',
    p('#e8eeee', '#1b2828', '#5f7777', '#cbdada', '#2f7f76', '#ffffff', '#dce7e6', '#d1dedd'),
    p('#101819', '#d6e4e3', '#7f9a99', '#233230', '#4fb8ab', '#05201d', '#162122', '#1c2a2b')),
  theme('murky-lagoon', 'Murky lagoon', 'Misty swamps',
    p('#eceee0', '#24281a', '#6f7550', '#d6dabb', '#6f7018', '#ffffff', '#e3e6d1', '#dadec5'),
    p('#15170d', '#e0e4cc', '#9aa070', '#2f331c', '#b5b840', '#171800', '#1c1f12', '#232718')),

  // ── Snow and mist: white, pale blue and violet greys ──
  theme('whiteout', 'Whiteout', 'Snow and mist',
    p('#f4f7fa', '#1f2933', '#66788a', '#d9e2ec', '#3f73a8', '#ffffff', '#eaf0f6', '#e0e9f1'),
    p('#12171d', '#e3ebf3', '#8ba0b5', '#263341', '#7fb1e3', '#08131f', '#19212a', '#202a35')),
  theme('frost-mist', 'Frost mist', 'Snow and mist',
    p('#eef3f5', '#1c2b30', '#5f7b84', '#d0dde2', '#2f7f96', '#ffffff', '#e3ecef', '#d9e5e9'),
    p('#0f171a', '#dbe8ec', '#7fa0aa', '#213339', '#64c3dc', '#04202a', '#152125', '#1b2a30')),
  theme('blizzard-lavender', 'Blizzard lavender', 'Snow and mist',
    p('#f3f2f8', '#24222f', '#6f6a86', '#dcd9ea', '#6352a6', '#ffffff', '#e9e7f2', '#dfdcec'),
    p('#14131b', '#e6e4f1', '#9791b3', '#2c2a3b', '#a597e6', '#120c26', '#1b1a24', '#22212d')),

  // ── Clay, rust and copper ──
  theme('red-clay', 'Red clay', 'Clay, rust and copper',
    p('#f6e3dd', '#3a1f17', '#8c5f50', '#e2c3b8', '#b5482f', '#ffffff', '#efd6cc', '#e8cbbf'),
    p('#241412', '#f0d9cf', '#b58b7d', '#47281f', '#d9694a', '#220c06', '#2e1a16', '#38211b')),
  theme('rust', 'Rust', 'Clay, rust and copper',
    p('#f1e6dd', '#33221a', '#806655', '#d9c4b3', '#b7410e', '#ffffff', '#e8d8cb', '#dfcdbd'),
    p('#1f1612', '#eadbd0', '#a58d7c', '#3d2c22', '#e0611f', '#1e0d03', '#291c17', '#33241d')),
  theme('copper', 'Copper', 'Clay, rust and copper',
    p('#f7ebe1', '#35231a', '#8d6a55', '#e6cdb9', '#9c5a2f', '#ffffff', '#f0dccb', '#e9d2be'),
    p('#22170f', '#f1dfd0', '#b8917a', '#46301f', '#d98b57', '#22120a', '#2c1e14', '#362619')),

  // ── Coffee and chocolate ──
  theme('arabica-coffee', 'Arabica coffee', 'Coffee and chocolate',
    p('#f0e6dc', '#2d1e14', '#7d6553', '#d8c6b6', '#6f4e37', '#ffffff', '#e7d9cb', '#decdbd'),
    p('#1c1410', '#e8dccf', '#a08b7a', '#382a20', '#b08968', '#1a0f07', '#251b15', '#2f231b')),
  theme('chocolate', 'Chocolate', 'Coffee and chocolate',
    p('#efe3e0', '#2b1712', '#7a5a52', '#d6bfba', '#6b3a2a', '#ffffff', '#e6d5d1', '#dcc8c3'),
    p('#170e0c', '#ecd9d3', '#a6837a', '#34211d', '#c07a5d', '#1b0b06', '#211412', '#2b1b17')),

  // ── Wood ──
  theme('oak', 'Oak', 'Wood',
    p('#f3e9d8', '#33260f', '#86704a', '#e0cfad', '#8b5a2b', '#ffffff', '#ebdcc0', '#e3d2b3'),
    p('#1f170c', '#eee0c6', '#b09a72', '#3f3018', '#cf9a55', '#22150a', '#281d10', '#322515')),
  theme('walnut', 'Walnut', 'Wood',
    p('#ece1d8', '#2b1c12', '#7c6250', '#d5c3b4', '#6b4226', '#ffffff', '#e2d3c6', '#d9c8ba'),
    p('#1a120d', '#e8d9cc', '#a58c78', '#38281d', '#b98155', '#1d0f07', '#231913', '#2d211a')),
  theme('birch', 'Birch', 'Wood',
    p('#f6f0e6', '#2f2a20', '#8a8068', '#e3dac6', '#8a6a3a', '#ffffff', '#eee6d6', '#e6dcc9'),
    p('#1d1a14', '#efe8d9', '#b0a68d', '#3b352a', '#d4b483', '#211a0e', '#26221a', '#302b21')),

  // ── Metals ──
  theme('gold', 'Gold', 'Metals',
    p('#fbf5dc', '#38300c', '#8f7c2c', '#ecdf9c', '#a67c00', '#ffffff', '#f4ebc0', '#eee2b0'),
    p('#1d1a08', '#f4ecc2', '#bda94f', '#423b16', '#f0c419', '#1f1800', '#272310', '#312c15')),
  theme('silver', 'Silver', 'Metals',
    p('#f2f3f5', '#22252b', '#6c7280', '#d5d8de', '#5f6b7d', '#ffffff', '#e8eaee', '#dde0e6'),
    p('#16181b', '#e4e6ea', '#9199a6', '#2c3036', '#b4bcc9', '#12151a', '#1d2024', '#25292e')),
  theme('platinum', 'Platinum', 'Metals',
    p('#f7f7fa', '#202226', '#6f7280', '#dfe0e6', '#56607a', '#ffffff', '#ecedf2', '#e2e4eb'),
    p('#17181c', '#e9eaee', '#9698a6', '#2b2d35', '#c9cfe4', '#101320', '#1e1f25', '#26282f')),
  theme('gun-metal', 'Gun metal', 'Metals',
    p('#e6e9ec', '#1e2429', '#5f6b75', '#ccd3d9', '#3d5566', '#ffffff', '#dce1e5', '#d1d8dd'),
    p('#14181c', '#dde3e8', '#8a97a2', '#262e35', '#6f97b3', '#0a1218', '#1a2026', '#21282f')),

  // ── Jewel tones ──
  theme('ruby', 'Ruby', 'Jewel tones',
    p('#fbeaee', '#3a0f1a', '#94505f', '#f0c6d0', '#b0123a', '#ffffff', '#f6d9e0', '#f0cbd4'),
    p('#1f0a10', '#f6dde3', '#b97d8b', '#43171f', '#ef476f', '#2a0410', '#29111a', '#341824')),
  theme('magenta', 'Magenta', 'Jewel tones',
    p('#fbe9f6', '#34102e', '#8f4f85', '#f1c6e8', '#b5179e', '#ffffff', '#f6d6ee', '#f0c8e6'),
    p('#1e0b1b', '#f6dcf1', '#b97fae', '#401a3a', '#f15bb5', '#2b0623', '#291126', '#331830')),
  theme('violet', 'Violet', 'Jewel tones',
    p('#f1ebfa', '#22143a', '#71599a', '#d9cbee', '#6d28d9', '#ffffff', '#e6dcf5', '#dccfef'),
    p('#150e22', '#e9e0f7', '#9c88c0', '#2c2044', '#a78bfa', '#170a33', '#1c142c', '#241a37')),
  theme('velvet', 'Velvet', 'Jewel tones',
    p('#f3e6ea', '#2a0f1e', '#80506a', '#e0c4d0', '#7b1e4d', '#ffffff', '#ead3dc', '#e2c7d3'),
    p('#180a12', '#efd9e3', '#a97a92', '#351a29', '#c2557f', '#1f0714', '#21101a', '#2b1722')),
  theme('cherry', 'Cherry', 'Jewel tones',
    p('#fdeceb', '#3b0d10', '#9a4f52', '#f4c9c8', '#c1121f', '#ffffff', '#f8d9d8', '#f2cbca'),
    p('#1f0b0c', '#f7dddb', '#bc7f7f', '#421a1c', '#f0505b', '#2b0509', '#291213', '#341a1b')),
  theme('pink', 'Pink', 'Jewel tones',
    p('#fdecf3', '#3a1526', '#9a5876', '#f5cfe0', '#d6336c', '#ffffff', '#f9dbe8', '#f3cddd'),
    p('#1f0d16', '#f8deea', '#bd85a0', '#431c2f', '#f783ac', '#2b0a17', '#29131e', '#341b28')),

  // ── Teal and seaweed ──
  theme('teal', 'Teal', 'Teal and seaweed',
    p('#e6f4f3', '#0f2a2a', '#4f7b7a', '#c2dfdd', '#0f766e', '#ffffff', '#d8ecea', '#cce4e2'),
    p('#0b1b1b', '#d7efed', '#7fb0ad', '#1a3838', '#2dd4bf', '#04201d', '#102626', '#163030')),
  theme('dark-teal', 'Dark teal', 'Teal and seaweed',
    p('#dfeeee', '#0a2224', '#4a7376', '#b9d5d6', '#0b5b5f', '#ffffff', '#d1e5e6', '#c4dcdd'),
    p('#07161a', '#cfe6e8', '#74a3a8', '#14313a', '#1fa5ad', '#031519', '#0c1f24', '#12292f')),
  theme('kelp', 'Kelp', 'Teal and seaweed',
    p('#e5efe9', '#10261d', '#4e7a66', '#c1dccd', '#2f7d58', '#ffffff', '#d8e8df', '#cce0d3'),
    p('#0a1611', '#d3ebdf', '#77a98f', '#163227', '#3fbf8a', '#03170f', '#101f18', '#162a21')),
  theme('nori', 'Nori', 'Teal and seaweed',
    p('#e6ece7', '#14201a', '#58705f', '#c6d4ca', '#3d5a45', '#ffffff', '#dae3dc', '#cfdad2'),
    p('#0d130f', '#d8e4db', '#8aa090', '#1f2c23', '#7fae8c', '#08110b', '#131b15', '#19241c')),
  theme('sea-lettuce', 'Sea lettuce', 'Teal and seaweed',
    p('#ecf3df', '#1f2b10', '#6a8440', '#d3e0b3', '#4f7d13', '#ffffff', '#e2ecc9', '#d8e4bb'),
    p('#10170a', '#e2edcc', '#96b264', '#283716', '#a6d63c', '#0f1a02', '#182010', '#202a16')),

  // ── Green forest ──
  theme('deep-woods', 'Deep woods', 'Green forest',
    p('#e8f0e6', '#14261a', '#587a5e', '#c8dbc4', '#2d6a3e', '#ffffff', '#dce8d9', '#d1e0cd'),
    p('#0e170f', '#dbe9d8', '#86a78a', '#1e3322', '#5fb36f', '#08170c', '#142018', '#1a2a1d')),
  theme('pine-canopy', 'Pine canopy', 'Green forest',
    p('#e6efe9', '#10261c', '#4f7a63', '#c3dbcd', '#1f7a55', '#ffffff', '#d9e8df', '#cee0d5'),
    p('#0a1712', '#d5ebe0', '#78ab90', '#163326', '#34d399', '#04180f', '#102019', '#162a20')),
  theme('mossy-glade', 'Mossy glade', 'Green forest',
    p('#eef1e2', '#232b12', '#6d7f45', '#d5deb9', '#5a7d1f', '#ffffff', '#e4ead0', '#dae2c3'),
    p('#12170a', '#e3ecd0', '#98ad68', '#2a3616', '#a3d13d', '#101a02', '#191f0e', '#212916')),

  // ── Blue ──
  theme('cobalt', 'Cobalt', 'Blue',
    p('#eaf0fb', '#0f1c3a', '#55699a', '#c9d6f0', '#1d4ed8', '#ffffff', '#dfe8f8', '#d4e0f4'),
    p('#0c1226', '#dde6fb', '#8195c4', '#1b2850', '#5b8cff', '#071033', '#121a33', '#19233f')),
  theme('sky', 'Sky', 'Blue',
    p('#e8f4fc', '#0c2236', '#4f7ea0', '#c3def0', '#0284c7', '#ffffff', '#daecf8', '#cde4f4'),
    p('#08151f', '#d9edf9', '#78a9c9', '#163044', '#38bdf8', '#04202f', '#0e1e2b', '#142837')),
  theme('midnight', 'Midnight', 'Blue',
    p('#e9ecf6', '#101533', '#5a6199', '#cbd0ea', '#3730a3', '#ffffff', '#dee2f2', '#d3d8ee'),
    p('#0a0c1c', '#dfe2f8', '#838ac4', '#1a1e40', '#818cf8', '#0b0d33', '#10132a', '#171b38')),

  // ── Steel blue ──
  theme('steel-blue', 'Steel blue', 'Steel blue',
    p('#e8eef3', '#15232f', '#5a7489', '#c7d4de', '#3b6f9c', '#ffffff', '#dce5ec', '#d1dce5'),
    p('#0f171e', '#dbe6ee', '#8199ad', '#202f3b', '#6ea6d3', '#0a1520', '#151f27', '#1c2832')),
  theme('cold-steel', 'Cold steel', 'Steel blue',
    p('#e6edf2', '#122029', '#587485', '#c4d3dd', '#35627f', '#ffffff', '#d9e4ec', '#cedbe5'),
    p('#0c151b', '#d8e5ed', '#7c9aad', '#1c2d38', '#7fb1cf', '#07141c', '#121c24', '#18252f')),
  theme('slate-harbour', 'Slate harbour', 'Steel blue',
    p('#eaeff2', '#1a2630', '#647a8b', '#cdd7de', '#4a6b8a', '#ffffff', '#dfe6eb', '#d4dde4'),
    p('#10171d', '#dfe7ed', '#8a9fb0', '#232f39', '#8fb0cf', '#0c1620', '#161e25', '#1d2730')),

  // ── Mars ──
  theme('red-planet', 'Red planet', 'Mars',
    p('#f4e2da', '#38180f', '#93553f', '#e4c2b3', '#c1440e', '#ffffff', '#ecd1c5', '#e4c6b8'),
    p('#1f0f0a', '#f2d9cd', '#b98470', '#44241a', '#ea6a34', '#240b03', '#291510', '#331c16')),
  theme('olympus-dust', 'Olympus dust', 'Mars',
    p('#f1e5d6', '#33200f', '#8a6544', '#e0ccb0', '#b0561d', '#ffffff', '#e8d8c2', '#dfcdb4'),
    p('#1d130a', '#eddcc6', '#ad9070', '#3e2b16', '#d98b45', '#201006', '#261a0f', '#302215')),
  theme('martian-dusk', 'Martian dusk', 'Mars',
    p('#ebeef4', '#1c2036', '#626a8c', '#cfd4e4', '#b8532d', '#ffffff', '#e0e5ee', '#d6dce8'),
    p('#0d1020', '#dfe3f2', '#8a93b8', '#1d2340', '#ef8a5d', '#230d04', '#131830', '#1a2038')),
]

/** The theme with this id — the default one when there is none (a theme that was removed from a newer or older version). */
export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!
}

/** Every CSS variable of `theme` in a light or dark appearance: `{ 'bg': '#…', 'tok-heading': '#…' … }` (no leading dashes). */
export function variablesOf(theme: Theme, dark: boolean): Record<string, string> {
  const c = dark ? theme.dark : theme.light
  return {
    bg: c.bg,
    fg: c.fg,
    muted: c.muted,
    border: c.border,
    accent: c.accent,
    'accent-fg': c.accentFg,
    'panel-bg': c.panel,
    'row-hover': c.hover,
    // The editor's headings follow the theme's accent, whatever its mood.
    'tok-heading': c.accent,
    ...(dark ? SIGNALS.dark : SIGNALS.light),
  }
}
