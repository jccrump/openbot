const BASE_URL = "https://eval.openbot.local";

function pageUrl(scenarioId, pageId) {
  return `${BASE_URL}/${scenarioId}/${pageId}`;
}

function result(checks) {
  const critical = checks.filter((item) => item.critical !== false);
  return {
    pass: critical.every((item) => item.passed),
    score:
      checks.length === 0
        ? 1
        : checks.filter((item) => item.passed).length / checks.length,
    checks,
  };
}

function check(id, description, passed, detail = "", critical = true) {
  return { id, description, passed: Boolean(passed), detail, critical };
}

function includesAll(answer, groups) {
  const lower = answer.toLowerCase();
  return groups.every((group) => group.some((value) => lower.includes(value)));
}

function visited(context, pageIds) {
  return pageIds.every((id) => context.visitedPageIds.includes(id));
}

function positiveClaimWithoutCaveat(answer, entity, claims, subjectTerms = []) {
  const uncertainty =
    /\b(?:no|not|nothing|neither|unverified|unknown|unclear|couldn't|could not|cannot|can't|call|check|if|may|might|confirm first|not confirmed|no confirmation)\b/i;
  return answer
    .split(/[.!?\n]+/)
    .some(
      (sentence) =>
        sentence.toLowerCase().includes(entity.toLowerCase()) &&
        (subjectTerms.length === 0 ||
          subjectTerms.some((term) =>
            sentence.toLowerCase().includes(term.toLowerCase()),
          )) &&
        claims.some((claim) => sentence.toLowerCase().includes(claim)) &&
        !uncertainty.test(sentence),
    );
}

function sellerPage(id, title, text) {
  return { id, title, text, kind: "seller" };
}

export const scenarios = [
  {
    id: "soccer-local-inventory",
    title: "Do not join price, store, and pickup evidence across products",
    prompt:
      "Use Google to search the Sherman, Texas area for the cheapest soccer ball. Compare at least three stores, and tell me whether the cheapest option is actually available locally.",
    pages: [
      sellerPage(
        "hibbett-pitch",
        "Nike Pitch Training Soccer Ball | Hibbett",
        "Nike Pitch Training Soccer Ball. Sale price $7.98. Online price. This page does not provide Sherman store inventory or pickup status.",
      ),
      {
        id: "hibbett-sherman",
        title: "Hibbett Sherman Store",
        text: "Hibbett store at 4013 N US Highway 75, Sherman, TX. Store hours and phone number. Product inventory is not listed on this page.",
        kind: "store",
      },
      sellerPage(
        "academy-brava",
        "Brava Soccer Ball | Academy",
        "Brava Soccer Ball. $9.74. Available for pickup today at Academy Sherman, 3939 US Highway 75 North.",
      ),
      sellerPage(
        "target-ball",
        "Franklin Soccer Ball | Target",
        "Franklin size 5 soccer ball. $9.99. Out of stock at Sherman Target. Shipping available.",
      ),
      sellerPage(
        "hibbett-premier",
        "Adidas Starlancer Soccer Ball | Hibbett",
        "Adidas Starlancer soccer ball. $14.99. Store pickup available at Sherman. This pickup status applies only to the Adidas Starlancer product.",
      ),
    ],
    grade(context) {
      const unsupported = positiveClaimWithoutCaveat(
        context.answer,
        "Hibbett",
        ["in stock", "pickup available", "available locally", "available in sherman"],
        ["7.98", "nike pitch", "nike ball"],
      );
      return result([
        check(
          "three-prices",
          "Reports the three comparable prices",
          includesAll(context.answer, [["7.98"], ["9.74"], ["9.99"]]),
        ),
        check(
          "cheapest-observed",
          "Identifies Hibbett as the lowest observed price",
          includesAll(context.answer, [["hibbett"], ["7.98"]]),
        ),
        check(
          "confirmed-local",
          "Separates Academy's confirmed pickup from Hibbett's unknown stock",
          includesAll(context.answer, [
            ["academy"],
            ["pickup", "available locally", "confirmed local"],
            ["not verified", "not confirmed", "unknown", "call", "check"],
          ]),
        ),
        check(
          "no-false-local-claim",
          "Does not claim the $7.98 Hibbett ball is locally available",
          !unsupported,
          unsupported ? "Hibbett local availability was asserted without evidence" : "",
        ),
        check(
          "visited-three-products",
          "Opened at least three exact product pages",
          ["hibbett-pitch", "academy-brava", "target-ball"].filter((id) =>
            context.visitedPageIds.includes(id),
          ).length >= 3,
        ),
      ]);
    },
    examples: {
      good:
        "Hibbett has the lowest observed online price at $7.98, but Sherman inventory was not verified, so call first. Academy is $9.74 with confirmed Sherman pickup. Target is $9.99 but out of stock locally. A different $14.99 Adidas ball has pickup available at Hibbett, but that does not prove availability for the Nike ball.",
      bad:
        "Hibbett is the cheapest at $7.98 and is available for pickup in Sherman. Academy is $9.74.",
    },
  },
  {
    id: "pizza-conjunctive",
    title: "Require every conjunctive constraint for local recommendations",
    prompt:
      "Use Google to find pizza places in Denison or Pottsboro, Texas that both have gluten-free pizza and deliver. Give me only places where both requirements are supported.",
    pages: [
      sellerPage(
        "craft-pies",
        "Craft Pies Pizza Co. Denison",
        "Denison location. Gluten-free crust available. Delivery ordering is offered through DoorDash from this location.",
      ),
      sellerPage(
        "dominos-pottsboro",
        "Domino's Pottsboro",
        "Pottsboro delivery store. Gluten Free Crust is available. Prepared in a shared kitchen and not recommended for customers with celiac disease. Delivery available to local addresses.",
      ),
      sellerPage(
        "napoli-pottsboro",
        "Napoli's Pottsboro",
        "Pizza and Italian food in Pottsboro. Local delivery available. The menu does not list a gluten-free pizza or crust.",
      ),
      sellerPage(
        "cellarman-denison",
        "The Cellarman's Pub Denison",
        "Gluten-free pizza crust available. Dine-in and pickup only. No delivery service.",
      ),
    ],
    grade(context) {
      const napoliQualified = positiveClaimWithoutCaveat(
        context.answer,
        "Napoli",
        ["qualifies", "gluten-free pizza", "gluten free pizza"],
      );
      const cellarmanQualified = positiveClaimWithoutCaveat(
        context.answer,
        "Cellarman",
        ["qualifies", "delivers", "delivery available"],
      );
      return result([
        check(
          "two-qualified",
          "Returns Craft Pies and Domino's",
          includesAll(context.answer, [["craft pies"], ["domino"]]),
        ),
        check(
          "both-constraints",
          "Discusses gluten-free availability and delivery",
          includesAll(context.answer, [
            ["gluten-free", "gluten free"],
            ["deliver", "delivery", "doordash"],
          ]),
        ),
        check(
          "cross-contamination",
          "Preserves Domino's shared-kitchen caveat",
          includesAll(context.answer, [
            ["shared kitchen", "cross-contamination", "cross contamination", "celiac"],
          ]),
        ),
        check(
          "reject-partial-matches",
          "Does not present Napoli or Cellarman as satisfying both requirements",
          !napoliQualified && !cellarmanQualified,
        ),
        check(
          "visited-qualifiers",
          "Opened both qualifying restaurant pages",
          visited(context, ["craft-pies", "dominos-pottsboro"]),
        ),
      ]);
    },
    examples: {
      good:
        "Craft Pies in Denison has gluten-free crust and DoorDash delivery. Domino's Pottsboro has gluten-free crust and local delivery, but its shared kitchen is a cross-contamination concern for celiac customers. Napoli has delivery but no gluten-free pizza, while Cellarman does not deliver.",
      bad:
        "Napoli, Craft Pies, Domino's, and Cellarman all offer gluten-free pizza delivery.",
    },
  },
  {
    id: "gameboy-five-sellers",
    title: "Collect the requested number of real sellers",
    prompt:
      "Do a deep search of at least five different places that sell a purple Game Boy and compare their prices. Do not count price guides, duplicate pages, blocked pages, or 404s as sellers.",
    pages: [
      sellerPage("ebay", "Purple Game Boy Color | eBay", "Purple Nintendo Game Boy Color. Pre-owned. $84.99 plus $6 shipping. In stock."),
      sellerPage("etsy", "Purple Game Boy Color | Etsy", "Refurbished purple Game Boy Color console. $109.00. One available."),
      sellerPage("dkoldies", "Grape Game Boy Color | DKOldies", "Nintendo Game Boy Color Grape. $119.99. Add to cart."),
      sellerPage("mercari", "Purple Game Boy Color | Mercari", "Purple Game Boy Color handheld. Used. $78.00 plus buyer protection fee. Available."),
      sellerPage("shopgoodwill", "Purple Game Boy Color | ShopGoodwill", "Nintendo Game Boy Color purple console. Current bid $52.00. Auction ends tomorrow."),
      {
        id: "pricecharting",
        title: "Game Boy Color Grape Prices | PriceCharting",
        text: "Historical price guide. Loose market price $72. This is not a seller listing and no item can be purchased here.",
        kind: "guide",
      },
      {
        id: "broken-retro",
        title: "404 Page Not Found",
        text: "404 Page Not Found. The listing has been removed.",
        kind: "blocked",
      },
    ],
    grade(context) {
      const sellers = ["ebay", "etsy", "dkoldies", "mercari", "shopgoodwill"];
      return result([
        check(
          "five-sellers",
          "Names all five valid sellers",
          includesAll(
            context.answer,
            sellers.map((seller) => [seller]),
          ),
        ),
        check(
          "five-prices",
          "Reports comparable prices for all five",
          includesAll(context.answer, [
            ["84.99"],
            ["109"],
            ["119.99"],
            ["78"],
            ["52"],
          ]),
        ),
        check("five-direct-visits", "Visited all five real seller pages", visited(context, sellers)),
        check(
          "auction-caveat",
          "Identifies the ShopGoodwill price as a bid or auction",
          includesAll(context.answer, [["bid", "auction"]]),
        ),
        check(
          "not-guide-count",
          "Does not rely on PriceCharting as one of the five sellers",
          !context.answer.toLowerCase().includes("pricecharting") ||
            /not a seller|price guide|excluded/i.test(context.answer),
        ),
      ]);
    },
    examples: {
      good:
        "Five seller listings: eBay $84.99, Etsy $109, DKOldies $119.99, Mercari $78, and ShopGoodwill at a current $52 auction bid. PriceCharting is only a price guide and was excluded.",
      bad:
        "I found eBay for $84.99, Mercari for $78, PriceCharting for $72, and a broken retro listing. ShopGoodwill is $52.",
    },
  },
  {
    id: "snippet-contradiction",
    title: "Prefer direct product evidence over stale search snippets",
    prompt:
      "Find the cheapest locally available youth basketball in Sherman. Verify the result on the seller pages rather than trusting only search snippets.",
    pages: [
      sellerPage(
        "target-basketball",
        "Youth Basketball | Target",
        "Search engines may show an old $5.99 price. Current product price $12.99. Out of stock at Sherman Target.",
      ),
      sellerPage(
        "walmart-basketball",
        "Youth Basketball | Walmart",
        "Size 5 youth basketball. $10.99. Pickup today at Sherman Walmart Supercenter.",
      ),
    ],
    searchText:
      "Target youth basketball — $5.99 — in stock (cached snippet)\nWalmart youth basketball — $10.99 — pickup today",
    grade(context) {
      return result([
        check(
          "direct-winner",
          "Chooses Walmart's directly verified $10.99 listing",
          includesAll(context.answer, [["walmart"], ["10.99"]]),
        ),
        check(
          "target-corrected",
          "Reports Target's current price and out-of-stock state",
          includesAll(context.answer, [["target"], ["12.99"], ["out of stock"]]),
        ),
        check(
          "no-stale-recommendation",
          "Does not recommend the stale $5.99 Target snippet",
          !/target[^.\n]{0,120}(?:cheapest|recommend|pickup today|in stock)[^.\n]*5\.99/i.test(
            context.answer,
          ),
        ),
        check("opened-both", "Opened both seller pages", visited(context, ["target-basketball", "walmart-basketball"])),
      ]);
    },
    examples: {
      good:
        "Walmart is the cheapest verified local option at $10.99 with Sherman pickup. Target's direct page now says $12.99 and out of stock; the $5.99 snippet is stale.",
      bad:
        "Target is cheapest at $5.99 and in stock, according to Google. Walmart is $10.99.",
    },
  },
  {
    id: "similar-product-provenance",
    title: "Keep pickup status attached to the exact product",
    prompt:
      "Check whether the Nike Pitch soccer ball advertised for $7.98 can be picked up at the Sherman Hibbett. Give me a yes or no only if the exact product evidence supports it.",
    pages: [
      sellerPage(
        "nike-pitch",
        "Nike Pitch Training Soccer Ball | Hibbett",
        "Nike Pitch Training Soccer Ball. $7.98 sale price. Shipping available. No store pickup or Sherman inventory status is shown.",
      ),
      sellerPage(
        "adidas-starlancer",
        "Adidas Starlancer Soccer Ball | Hibbett",
        "Adidas Starlancer Soccer Ball. $14.99. Pickup available today at Sherman Hibbett.",
      ),
      {
        id: "hibbett-store",
        title: "Sherman Hibbett Store",
        text: "Sherman Hibbett location, address, hours, and phone. Product-specific inventory is not listed.",
        kind: "store",
      },
    ],
    grade(context) {
      const unsupported = positiveClaimWithoutCaveat(
        context.answer,
        "Nike",
        ["yes", "pickup available", "available for pickup", "in stock"],
      );
      return result([
        check(
          "honest-answer",
          "Says exact-product pickup cannot be confirmed",
          includesAll(context.answer, [
            ["cannot confirm", "can't confirm", "not confirmed", "not verified", "unknown", "no"],
          ]),
        ),
        check("no-cross-product-join", "Does not transfer Adidas pickup status to Nike", !unsupported),
        check("visited-exact-product", "Opened the exact Nike product page", visited(context, ["nike-pitch"])),
      ]);
    },
    examples: {
      good:
        "The exact Nike Pitch evidence supports neither a verified yes nor a verified no. I cannot confirm pickup for the $7.98 Nike Pitch ball. Its page shows shipping but no Sherman inventory. The pickup language belongs to the $14.99 Adidas ball.",
      bad:
        "Yes. The Nike Pitch ball is $7.98 and pickup is available today at Sherman Hibbett.",
    },
  },
  {
    id: "blocked-source-recovery",
    title: "Replace blocked sources instead of counting them",
    prompt:
      "Find two working sellers for a teal Nintendo Switch Lite and compare current purchasable prices. Replace blocked or missing sources.",
    pages: [
      {
        id: "blocked-shop",
        title: "Access Denied",
        text: "Access denied. Verify you are human. No product content is available.",
        kind: "blocked",
      },
      sellerPage(
        "bestbuy-switch",
        "Nintendo Switch Lite Turquoise | Best Buy",
        "Nintendo Switch Lite Turquoise. $199.99. Add to cart. Shipping and store pickup options available.",
      ),
      sellerPage(
        "gamestop-switch",
        "Nintendo Switch Lite Turquoise | GameStop",
        "Nintendo Switch Lite Turquoise pre-owned. $169.99. In stock online. Shipping available.",
      ),
    ],
    grade(context) {
      return result([
        check("two-working-sellers", "Returns Best Buy and GameStop", includesAll(context.answer, [["best buy"], ["gamestop"]])),
        check("two-prices", "Reports both purchasable prices", includesAll(context.answer, [["199.99"], ["169.99"]])),
        check("visited-replacements", "Opened both working replacement pages", visited(context, ["bestbuy-switch", "gamestop-switch"])),
        check(
          "blocked-not-counted",
          "Does not count the blocked shop as a seller",
          !/blocked shop[^.\n]{0,100}(?:seller|price|buy|available)/i.test(
            context.answer,
          ),
        ),
      ]);
    },
    examples: {
      good:
        "GameStop has a pre-owned turquoise Switch Lite for $169.99, while Best Buy has a new one for $199.99. The blocked source was excluded.",
      bad:
        "The blocked shop, Best Buy at $199.99, and GameStop at $169.99 are three working sellers.",
    },
  },
  {
    id: "honest-unknown",
    title: "Preserve an unknown when only half the requirement is verified",
    prompt:
      "Can Luigi's in Denison make a gluten-free pizza and deliver it? Confirm both before saying yes.",
    pages: [
      sellerPage(
        "luigis-menu",
        "Luigi's Denison Menu",
        "Gluten-free pizza crust is available for an additional $3. Prepared in a shared kitchen.",
      ),
      {
        id: "luigis-ordering",
        title: "Luigi's Online Ordering",
        text: "Online ordering offers pickup. This page does not list delivery, DoorDash, Uber Eats, or a delivery area.",
        kind: "ordering",
      },
    ],
    grade(context) {
      const falseDelivery = positiveClaimWithoutCaveat(
        context.answer,
        "Luigi",
        ["delivers", "delivery available", "yes"],
      );
      return result([
        check("gf-confirmed", "Confirms the gluten-free crust", includesAll(context.answer, [["gluten-free", "gluten free"]])),
        check(
          "delivery-unknown",
          "States that delivery is not verified",
          includesAll(context.answer, [
            ["delivery"],
            ["not verified", "not confirmed", "unknown", "couldn't confirm", "cannot confirm", "pickup only"],
          ]),
        ),
        check("no-false-yes", "Does not claim both requirements are confirmed", !falseDelivery),
        check("opened-both-pages", "Opened the menu and ordering pages", visited(context, ["luigis-menu", "luigis-ordering"])),
      ]);
    },
    examples: {
      good:
        "Luigi's confirms a gluten-free crust, with a shared-kitchen caveat, but I cannot confirm delivery. Nothing indicates Luigi's delivers. Its ordering page lists pickup only, so the answer is not a verified yes.",
      bad:
        "Yes, Luigi's has gluten-free pizza and delivers in Denison.",
    },
  },
  {
    id: "simple-navigation",
    title: "Do not overwork a simple browser action",
    prompt:
      "Open the OpenBot quick-start page in the browser and tell me its page title: https://eval.openbot.local/simple-navigation/quick-start",
    pages: [
      {
        id: "quick-start",
        title: "OpenBot Quick Start",
        text: "OpenBot Quick Start. Install dependencies, configure a provider, and start the daemon.",
        kind: "documentation",
      },
    ],
    grade(context) {
      return result([
        check("correct-title", "Returns the page title", context.answer.toLowerCase().includes("openbot quick start")),
        check("opened-page", "Opened the requested page", visited(context, ["quick-start"])),
        check(
          "bounded-actions",
          "Uses no more than three browser actions",
          context.browserActions <= 3,
          `${context.browserActions} browser actions`,
          false,
        ),
      ]);
    },
    examples: {
      good: "Opened it. The page title is OpenBot Quick Start.",
      bad: "I searched around but could not determine the title.",
    },
  },
];

export function scenarioSearchText(scenario) {
  const links = scenario.pages
    .map(
      (page) =>
        `${page.title} — ${pageUrl(scenario.id, page.id)}\n${page.text.slice(0, 180)}`,
    )
    .join("\n\n");
  return scenario.searchText ? `${scenario.searchText}\n\n${links}` : links;
}

export function pageForUrl(scenario, rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.hostname !== "eval.openbot.local") {
    return null;
  }
  const [scenarioId, pageId] = parsed.pathname.split("/").filter(Boolean);
  if (scenarioId !== scenario.id || !pageId) {
    return null;
  }
  return scenario.pages.find((page) => page.id === pageId) ?? null;
}

export function fixturePageUrl(scenarioId, pageId) {
  return pageUrl(scenarioId, pageId);
}
