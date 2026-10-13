# Tack

An open-source sticky-note board for research, brainstorming and topic mapping. Think Miro's corkboard, minus the 3-board limit and the blurry exports.

- **Unlimited boards**, saved automatically in your browser
- **Sticky notes** that auto-size their text, plus text boxes
- **Symbol library (`K`):** flowchart shapes (rectangle, ellipse, diamond, triangle, hexagon, parallelogram, cylinder), math symbols, and 1,700+ searchable [Lucide](https://lucide.dev) icons
- **Links** in notes are shortened and clickable, and **⌘F** searches the board
- **Right-angle connectors** with arrowheads and labels. Each end keeps the side you drew it from, lines hop where they cross, and notes snap into line so connectors run straight
- **Sticky notes in S / M / L**, with color and size picked before you place them
- **Images:** paste, drag in, or press `I`. Big photos are scaled down to 2400 px
- **Real exports:** vector **SVG**, vector **PDF** (selectable text), **PNG** up to 8×, and **JSON** for backups. Exports have no background by default, and you pick **Light** or **Dark** colors so lines and text stay readable wherever the image ends up
- No account, no server, no build step: three static files

## Run it

Open `index.html` in a browser. Or serve the folder:

```bash
python3 serve.py
```

then visit http://localhost:5178.

PDF export loads [jsPDF](https://github.com/parallax/jsPDF) and [svg2pdf.js](https://github.com/yWorks/svg2pdf.js), and the icon library loads [Lucide](https://lucide.dev) (ISC license), from a CDN the first time you use them. Icons you've placed are saved in the board, so everything else works offline.

## Put it on your own domain (Cloudflare)

Tack can be served at a path on a domain you manage with Cloudflare, like `yourdomain.com/tack`. It only takes over that path, so the rest of the site is untouched.

1. In `wrangler.jsonc`, replace `YOUR-DOMAIN.com` (four places) with your domain.
2. Sign in to Cloudflare once:
   ```bash
   npx wrangler login
   ```
3. Publish (run this again whenever you change Tack):
   ```bash
   sh deploy.sh
   ```

To use a different path than `/tack`, change it in the two routes in `wrangler.jsonc` and in `deploy.sh`.

### Sync across devices (optional)

The hosted copy can sync boards and images through Cloudflare (D1 for boards, KV for images), with sign-in handled by Cloudflare Access. Without it, boards stay in each browser.

1. Create the storage once (already done for parkerrupe.xyz; IDs are in `wrangler.jsonc`):
   ```bash
   npx wrangler d1 create tack
   npx wrangler kv namespace create tack-images
   npx wrangler d1 execute tack --remote --file worker/schema.sql
   ```
2. In the Cloudflare dashboard, open **Zero Trust → Access → Applications**, add a **self-hosted** application for your domain with the path `tack/api`, and give it an Allow policy (for example, your email address, with the one-time PIN login).
3. Put your team domain (`<team>.cloudflareaccess.com`) and the application's **AUD tag** into `vars` in `wrangler.jsonc`, then `sh deploy.sh`.

Tack keeps working offline and saves locally first; changes sync a couple of seconds later. If the same board was changed on two devices, the older copy is kept as a separate “conflict copy” board, so nothing is overwritten. Each signed-in person only ever sees their own boards.

To test locally: put `DEV_USER=you@example.com` in `.dev.vars`, then `npx wrangler dev --local-upstream localhost:8787` and open http://localhost:8787/tack/. That bypass only works on localhost.

## Using it

| Do this | Get this |
| --- | --- |
| Double-click the canvas | New sticky note |
| Select an item and type, double-click it, or press Enter | Edit its text |
| `**word**`, or ⌘B while editing | Bold |
| Hover a note and drag one of its dots | Connect it. Drop on empty space to create a new connected note |
| Tab / ⇧Tab on a selected note | New connected note to the right / below |
| `V` `H` `N` `T` `R` `O` `L` | Select, pan, sticky, text, rectangle, ellipse, line |
| `I`, ⌘V, or drag files in | Add images |
| `K` | Shapes & icons library. Click to add, or drag onto the board |
| Space + drag, or scroll | Pan |
| ⌘ + scroll, or pinch | Zoom |
| ⇧1 / ⌘0 | Fit board / 100% |
| ⌥ + drag | Duplicate while dragging |
| ⌘ + drag | Move without snapping |
| ⌘D, ⌘C, ⌘X, ⌘V | Duplicate, copy, cut, paste. Pasting plain text makes a sticky |
| ⌘Z / ⇧⌘Z | Undo / redo |
| ⌘F | Search the board. Enter / ⇧Enter for next / previous |
| Click a link in a note | Open it in a new tab |
| ⌘⇧E | Export |

## Where your data lives

Boards are stored in your browser's `localStorage`, and images in its IndexedDB, so they stay on this browser on this computer. Use **Export → JSON** to back a board up or move it somewhere else (images are included in the file), and **☰ → Import .json** to load it again.

## How it's built

`app.js` is plain JavaScript with no dependencies. The board is drawn as SVG, and every export comes from that same SVG markup, so what you see is what you get.

- **SVG:** written out directly.
- **PNG:** the SVG rasterized onto a canvas at the scale you pick.
- **PDF:** the SVG converted to vector PDF.

## License

MIT
