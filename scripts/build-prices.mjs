// Pulls product + price data from TCGCSV and writes one small JSON file per game.
// No dependencies: Node 20+ has global fetch.
//
// Output goes to docs/ so GitHub Pages can serve it:
//   docs/index.json                 { updated, categories: [...] }
//   docs/prices-<slug>.json         { updated, category, cards: [...] }
//
// Each card is [productId, name, number, setName, marketPrice, imageUrl]
// kept as an array rather than an object to keep the files small.

import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://tcgcsv.com/tcgplayer";

// Add or remove games here. Names are matched loosely against TCGCSV's category list.
const WANTED = [
  "Pokemon",
  "One Piece Card Game",
  "Union Arena",
];

const CONCURRENCY = 5;
const RETRIES = 3;

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function getJSON(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { "user-agent": "tcg-price-sync" } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    if (attempt >= RETRIES) throw new Error(`${url} failed: ${err.message}`);
    await new Promise((r) => setTimeout(r, 400 * attempt));
    return getJSON(url, attempt + 1);
  }
}

// run tasks a few at a time so we are polite to the host
async function pool(items, worker) {
  const out = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length) {
      const mine = i++;
      out[mine] = await worker(items[mine], mine);
    }
  });
  await Promise.all(runners);
  return out;
}

// A product can have several printings (Normal, Foil, Holofoil...).
// Prefer Normal, then Foil, then whatever has a price.
function bestPrice(rows) {
  const priced = rows.filter((r) => typeof r.marketPrice === "number" && r.marketPrice > 0);
  if (!priced.length) return null;
  const order = ["normal", "foil", "holofoil", "reverse holofoil"];
  priced.sort((a, b) => {
    const ai = order.indexOf(String(a.subTypeName || "").toLowerCase());
    const bi = order.indexOf(String(b.subTypeName || "").toLowerCase());
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  return priced[0].marketPrice;
}

function numberOf(product) {
  const ext = product.extendedData || [];
  const hit = ext.find((e) => /^(number|card number)$/i.test(e.name || ""));
  return hit ? String(hit.value).trim() : "";
}

async function buildCategory(category) {
  const { categoryId, name } = category;
  const groups = (await getJSON(`${BASE}/${categoryId}/groups`)).results || [];
  process.stdout.write(`${name}: ${groups.length} sets\n`);

  const perGroup = await pool(groups, async (group) => {
    const [prodRes, priceRes] = await Promise.all([
      getJSON(`${BASE}/${categoryId}/${group.groupId}/products`),
      getJSON(`${BASE}/${categoryId}/${group.groupId}/prices`),
    ]);

    const priceByProduct = new Map();
    for (const row of priceRes.results || []) {
      const list = priceByProduct.get(row.productId) || [];
      list.push(row);
      priceByProduct.set(row.productId, list);
    }

    const cards = [];
    for (const p of prodRes.results || []) {
      const price = bestPrice(priceByProduct.get(p.productId) || []);
      if (price == null) continue; // no price, nothing for us to sync
      cards.push([
        p.productId,
        p.cleanName || p.name || "",
        numberOf(p),
        group.name || "",
        Math.round(price * 100) / 100,
        p.imageUrl || "",
      ]);
    }
    return cards;
  });

  return perGroup.flat();
}

async function main() {
  const categories = (await getJSON(`${BASE}/categories`)).results || [];

  const picked = WANTED.map((want) => {
    const hit =
      categories.find((c) => norm(c.name) === norm(want)) ||
      categories.find((c) => norm(c.displayName) === norm(want)) ||
      categories.find((c) => norm(c.name).includes(norm(want)));
    if (!hit) console.warn(`!! no TCGCSV category matched "${want}"`);
    return hit;
  }).filter(Boolean);

  if (!picked.length) throw new Error("none of the wanted categories were found");

  await mkdir("docs", { recursive: true });
  const updated = new Date().toISOString();
  const index = { updated, categories: [] };

  for (const category of picked) {
    const cards = await buildCategory(category);
    const file = `prices-${slug(category.name)}.json`;
    await writeFile(`docs/${file}`, JSON.stringify({ updated, category: category.name, cards }));
    index.categories.push({ name: category.name, file, count: cards.length });
    process.stdout.write(`  wrote docs/${file} (${cards.length} priced products)\n`);
  }

  await writeFile("docs/index.json", JSON.stringify(index, null, 2));
  process.stdout.write(`done — ${index.categories.reduce((n, c) => n + c.count, 0)} products total\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
