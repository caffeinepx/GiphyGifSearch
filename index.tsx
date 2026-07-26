/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * This plugin is Forked from TenorGifRestore
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import { isNonNullish } from "@utils/guards";
import definePlugin from "@utils/types";
import { FluxDispatcher, LocaleStore } from "@webpack/common";

// My Personal API Key (place your own because mine would run out of requests)
const GIPHY_KEY = "oTYJsWrWGnaWjKKxgGzH90StXmdmQYrV";

let cachedCategories: TrendingCategories | null = null;
// analytics pingback URLs keyed by gif id (for registershare / onsent)
const analyticsById = new Map<string, string>();

interface GiphyImage {
    url?: string;
    width?: string;
    height?: string;
    mp4?: string;
    webp?: string;
}

interface GiphyResult {
    id: string;
    title?: string;
    url: string;
    images: Record<string, GiphyImage>;
    analytics?: {
        onsent?: { url: string; };
    };
}

interface GiphyCategory {
    name: string;
    gif?: GiphyResult;
}

interface DiscordGif {
    id: string;
    title: string;
    url: string;
    src: string;
    gif_src: string;
    width: number;
    height: number;
    preview: string;
}

interface TrendingCategories {
    trendingCategories: Record<"name" | "src", string>[];
    trendingGIFPreview: { src: string; };
}

function pickImage(images: Record<string, GiphyImage>, ...keys: string[]): GiphyImage | undefined {
    for (const key of keys) {
        const img = images[key];
        if (img && (img.url || img.mp4 || img.webp)) return img;
    }
    return undefined;
}

function toDiscordGif(item: GiphyResult): DiscordGif | null {
    const { images } = item;
    if (!images) return null;

    const gif = pickImage(images, "original", "downsized_medium", "downsized", "fixed_height");
    const video = pickImage(images, "original", "fixed_height", "fixed_width", "preview");
    const preview = pickImage(images, "preview_gif", "fixed_width_still", "fixed_height_still", "original_still", "downsized_still");

    const gifUrl = gif?.url;
    // Discord's picker uses a video source for playback in the grid (Tenor used webm)
    const srcUrl = video?.mp4 || video?.webp || gifUrl;
    const previewUrl = preview?.url || gifUrl;

    if (!gifUrl || !srcUrl || !previewUrl) return null;

    const width = Number(gif?.width || video?.width || 0);
    const height = Number(gif?.height || video?.height || 0);
    if (!width || !height) return null;

    if (item.analytics?.onsent?.url) {
        analyticsById.set(item.id, item.analytics.onsent.url);
    }

    return {
        id: item.id,
        title: "", // discord always returns a blank string
        url: item.url,
        gif_src: gifUrl,
        src: srcUrl,
        width,
        height,
        preview: previewUrl
    };
}

function mapToDiscordGifs(items: GiphyResult[]) {
    return items.map(toDiscordGif).filter(isNonNullish);
}

function giphyLang() {
    // Giphy expects a 2-letter ISO 639-1 code
    return (LocaleStore.locale || "en").split("-")[0].toLowerCase();
}

async function giphyFetch<TResult>(path: string, params: Record<string, string> = {}) {
    const url = `https://api.giphy.com/v1${path}?` + new URLSearchParams({
        api_key: GIPHY_KEY,
        ...params
    });

    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`GET ${path}: Giphy API request failed with status ${res.status}`);

    return res.json() as Promise<TResult>;
}

// Paginate with offset (Giphy max page size for beta keys is 50; offset max ~4999)
async function fetchGiphyResults(path: string, limit: number, extra: Record<string, string> = {}) {
    const pageSize = Math.min(limit, 50);
    const items: GiphyResult[] = [];
    const seen = new Set<string>();
    let offset = 0;

    while (items.length < limit) {
        const params: Record<string, string> = {
            ...extra,
            limit: String(Math.min(limit - items.length, pageSize)),
            offset: String(offset)
        };

        const { data: page, pagination } = await giphyFetch<{
            data: GiphyResult[];
            pagination?: { count?: number; total_count?: number; offset?: number; };
        }>(path, params);

        if (!page?.length) break;

        const previousLength = items.length;
        for (const item of page) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);

            items.push(item);
            if (items.length >= limit) break;
        }
        if (items.length === previousLength) break;

        const count = pagination?.count ?? page.length;
        offset += count;

        const total = pagination?.total_count;
        if (total != null && offset >= total) break;
        // Giphy search offset max is 4999
        if (offset >= 4999) break;
    }

    return items;
}

async function fetchCategories(): Promise<TrendingCategories | null> {
    return giphyFetch<{ data?: GiphyCategory[]; }>("/gifs/categories")
        .then(({ data }) => {
            if (!data?.length) return null;

            const trendingCategories = data
                .map(c => {
                    const src =
                        c.gif?.images?.fixed_height?.url
                        || c.gif?.images?.preview_gif?.url
                        || c.gif?.images?.original?.url;
                    if (!src) return null;
                    return { name: c.name, src };
                })
                .filter(isNonNullish);

            if (!trendingCategories.length) return null;

            return {
                trendingCategories,
                trendingGIFPreview: { src: trendingCategories[0].src }
            };
        })
        .catch(() => null);
}

export default definePlugin({
    name: "GiphyGifSearch",
    description: "Adds Giphy GIF search, Powered by GIPHY",
    authors: [Devs.Lunascape],

    patches: [
        {
            find: "renderHeaderContent()",
            replacement: {
                match: /placeholder:(\i),"aria-label":(\i)/,
                replace: 'placeholder:$1?.replace(/Tenor|Klipy/gi,"Giphy"),"aria-label":$2?.replace(/Tenor|Klipy/gi,"Giphy")'
            }
        },
        {
            find: '"GIF_PICKER_TRENDING_FETCH_SUCCESS",trendingCategories:',
            replacement: [
                {
                    match: /let \i=Date\.now\(\);\i\([^)]+\),\i\.\i\.get\(\{url:\i\.\i\.GIFS_SEARCH,query:\{q:(\i),/,
                    replace: "return $self.handleSearchFetch($1);$&"
                },
                {
                    match: /""!==(\i)&&null!=\1&&\i\.\i\.get\(\{url:\i\.\i\.GIFS_SUGGEST,/,
                    replace: "return $self.handleSuggestionsFetch($1);$&"
                },
                {
                    match: /\i\.\i\.get\(\{url:\i\.\i\.GIFS_TRENDING,/,
                    replace: "return $self.handleTrendingFetch();$&"
                },
                {
                    match: /let \i=Date\.now\(\);\i\([^)]+\),\i\.\i\.get\(\{url:\i\.\i\.GIFS_TRENDING_GIFS,/,
                    replace: "return $self.handleTrendingGifsFetch();$&"
                },
                {
                    match: /\i\.\i\.post\(\{url:\i\.\i\.GIFS_SELECT,body:\{id:(\i),q:(\i),provider:\i\}/,
                    replace: "return $self.handleGifSelect($1,$2);$&"
                }
            ]
        },
        {
            find: '"IntegrationQueryStore"',
            replacement: {
                match: /(?<=search\((\i),(\i)\)\{)null==\i\.getResults\(\1,\2\)&&/,
                replace: "return $self.giphyIntegrationSearch($1,$2);null==void 0&&"
            }
        }
    ],

    async start() {
        cachedCategories = await fetchCategories() ?? cachedCategories;
    },

    handleSearchFetch(query: string) {
        // discord has a 100 result limit for normal search
        fetchGiphyResults("/gifs/search", 100, { q: query, lang: giphyLang() })
            .then(results => {
                const items = mapToDiscordGifs(results);
                FluxDispatcher.dispatch(
                    items.length
                        ? { type: "GIF_PICKER_QUERY_SUCCESS", query, items }
                        : { type: "GIF_PICKER_QUERY_FAILURE", query }
                );
            })
            .catch(() => {
                FluxDispatcher.dispatch({ type: "GIF_PICKER_QUERY_FAILURE", query });
            });
    },

    async handleSuggestionsFetch(query: string) {
        if (!query) return;

        const { data } = await giphyFetch<{ data?: Array<{ name: string; }>; }>(
            "/gifs/search/tags",
            { q: query, limit: "5" }
        );

        const results = (data ?? []).map(t => t.name);
        FluxDispatcher.dispatch({ type: "GIF_PICKER_SUGGESTIONS_SUCCESS", query, items: results });
    },

    async handleTrendingFetch() {
        if (!cachedCategories) {
            cachedCategories = await fetchCategories();

            if (!cachedCategories) return;
        }

        FluxDispatcher.dispatch({ type: "GIF_PICKER_TRENDING_FETCH_SUCCESS", ...cachedCategories });
    },

    handleGifSelect(id: string, _query: string) {
        // Giphy analytics pingback (onsent) when a gif is sent
        const base = analyticsById.get(id);
        if (!base) return;

        try {
            const url = new URL(base);
            url.searchParams.set("ts", String(Date.now()));
            fetch(url.toString()).catch(() => { });
        } catch {
            // ignore malformed analytics URLs
        }
    },

    handleTrendingGifsFetch() {
        fetchGiphyResults("/gifs/trending", 50)
            .then(results => {
                const items = mapToDiscordGifs(results);
                FluxDispatcher.dispatch(
                    items.length
                        ? { type: "GIF_PICKER_QUERY_SUCCESS", items }
                        : { type: "GIF_PICKER_QUERY_FAILURE" }
                );
            })
            .catch(() => {
                FluxDispatcher.dispatch({ type: "GIF_PICKER_QUERY_FAILURE" });
            });
    },

    giphyIntegrationSearch(integration: string, query: string) {
        FluxDispatcher.dispatch({ type: "INTEGRATION_QUERY", integration, query });

        fetchGiphyResults("/gifs/search", 20, { q: query, lang: giphyLang() })
            .then(results => {
                const items = mapToDiscordGifs(results);
                FluxDispatcher.dispatch(
                    items.length
                        ? { type: "INTEGRATION_QUERY_SUCCESS", integration, query, results: items }
                        : { type: "INTEGRATION_QUERY_FAILURE", integration, query }
                );
            })
            .catch(() => {
                FluxDispatcher.dispatch({ type: "INTEGRATION_QUERY_FAILURE", integration, query, results: [] });
            });
    }
});
