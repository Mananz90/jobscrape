/**
 * Regional coverage per source. "global" = accepts any location string; a list = supported ISO-3166 alpha-2 codes.
 * `host` maps a country to the regional site so each board is queried on its own country edition.
 */
export const COVERAGE: Record<string, "global" | string[]> = {
  linkedin: "global", "linkedin-browser": "global", "apify-linkedin": "global",
  indeed: Object.keys(INDEED_HOSTS()), "indeed-browser": Object.keys(INDEED_HOSTS()), "apify-indeed": Object.keys(INDEED_HOSTS()),
  glassdoor: Object.keys(GLASSDOOR_HOSTS()), "glassdoor-browser": Object.keys(GLASSDOOR_HOSTS()), "apify-glassdoor": Object.keys(GLASSDOOR_HOSTS()),
  "apify-ziprecruiter": ["US", "CA", "GB"],
  "apify-naukri": ["IN", "AE", "SA", "QA", "KW", "BH", "OM"],
  "apify-stepstone": ["DE", "AT", "BE"],
  adzuna: ["GB", "US", "AT", "AU", "BE", "BR", "CA", "CH", "DE", "ES", "FR", "IN", "IT", "MX", "NL", "NZ", "PL", "SG", "ZA"],
  jooble: "global", googlejobs: "global",
  themuse: ["US", "GB", "CA", "DE", "IE", "NL", "FR", "AU", "IN", "SG"],
  usajobs: ["US"],
  jobicy: "global", himalayas: "global", remotive: "global", remoteok: "global",
  arbeitnow: ["DE", "AT", "CH", "NL", "GB", "FR", "ES", "IT", "PL", "PT", "SE", "IE"],
};

export function INDEED_HOSTS(): Record<string, string> {
  return { US: "www.indeed.com", GB: "uk.indeed.com", DE: "de.indeed.com", FR: "fr.indeed.com", IN: "in.indeed.com", CA: "ca.indeed.com", AU: "au.indeed.com", NL: "nl.indeed.com",
    ES: "es.indeed.com", IT: "it.indeed.com", IE: "ie.indeed.com", CH: "ch.indeed.com", AT: "at.indeed.com", SG: "sg.indeed.com", AE: "ae.indeed.com", SE: "se.indeed.com", PL: "pl.indeed.com",
    PT: "pt.indeed.com", BR: "br.indeed.com", MX: "mx.indeed.com", JP: "jp.indeed.com", BE: "be.indeed.com", DK: "dk.indeed.com", NO: "no.indeed.com", FI: "fi.indeed.com", NZ: "nz.indeed.com", ZA: "za.indeed.com", HK: "hk.indeed.com" };
}
export function GLASSDOOR_HOSTS(): Record<string, string> {
  return { US: "www.glassdoor.com", GB: "www.glassdoor.co.uk", DE: "www.glassdoor.de", FR: "www.glassdoor.fr", IN: "www.glassdoor.co.in", CA: "www.glassdoor.ca", AU: "www.glassdoor.com.au",
    NL: "www.glassdoor.nl", ES: "www.glassdoor.es", IT: "www.glassdoor.it", IE: "www.glassdoor.ie", CH: "www.glassdoor.ch", AT: "www.glassdoor.at", SG: "www.glassdoor.sg", BE: "www.glassdoor.be", BR: "www.glassdoor.com.br", MX: "www.glassdoor.com.mx", HK: "www.glassdoor.com.hk", NZ: "www.glassdoor.co.nz" };
}

export function covers(source: string, country?: string): boolean {
  const c = COVERAGE[source];
  if (!country || !c || c === "global") return true;
  return c.includes(country.toUpperCase());
}
export function coverageLabel(source: string): string {
  const c = COVERAGE[source];
  if (!c) return "";
  if (c === "global") return "global";
  return c.length > 6 ? `${c.length} countries` : c.join("/");
}

/** Location words that place a job inside a region (used when a whole region is searched without a country). */
export const REGION_TERMS: Record<string, string[]> = {
  europe: ["germany", "deutschland", "france", "uk", "united kingdom", "england", "scotland", "london", "berlin", "munich", "münchen", "frankfurt", "hamburg", "cologne", "köln", "stuttgart", "düsseldorf", "paris", "netherlands", "amsterdam", "rotterdam", "spain", "madrid", "barcelona", "italy", "milan", "rome", "poland", "warsaw", "krakow", "portugal", "lisbon", "ireland", "dublin", "sweden", "stockholm", "denmark", "copenhagen", "norway", "oslo", "finland", "helsinki", "austria", "vienna", "wien", "switzerland", "zurich", "zürich", "basel", "geneva", "belgium", "brussels", "czech", "prague", "greece", "athens", "romania", "bucharest", "hungary", "budapest", "emea", "europe", "eu"],
  northamerica: ["united states", "usa", "u.s.", "new york", "san francisco", "seattle", "austin", "boston", "chicago", "los angeles", "denver", "atlanta", "miami", "canada", "toronto", "vancouver", "montreal", "ottawa", "mexico", "north america", "americas", "nyc"],
  asia: ["india", "bangalore", "bengaluru", "mumbai", "delhi", "gurgaon", "noida", "hyderabad", "pune", "chennai", "china", "beijing", "shanghai", "japan", "tokyo", "singapore", "hong kong", "korea", "seoul", "taiwan", "taipei", "vietnam", "thailand", "bangkok", "indonesia", "jakarta", "philippines", "manila", "malaysia", "uae", "dubai", "abu dhabi", "apac", "asia"],
  oceania: ["australia", "sydney", "melbourne", "brisbane", "perth", "new zealand", "auckland", "wellington", "oceania"],
  latam: ["brazil", "brasil", "sao paulo", "são paulo", "argentina", "buenos aires", "chile", "santiago", "colombia", "bogota", "peru", "lima", "uruguay", "latam", "south america", "mexico"],
};
export function inRegion(region: string, location: string | null | undefined, remote?: boolean | null): boolean {
  const terms = REGION_TERMS[region]; if (!terms) return true;
  const loc = (location ?? "").toLowerCase();
  if (!loc) return remote === true;
  if (remote && /anywhere|worldwide|global|remote/.test(loc)) return true;
  return terms.some((t) => new RegExp(`(^|[^a-z])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(loc));
}

