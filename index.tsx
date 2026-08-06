/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * This plugin is Forked from TenorGifRestore
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { Devs, IS_LINUX } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { getTheme, Theme } from "@utils/discord";
import { isNonNullish } from "@utils/guards";
import definePlugin from "@utils/types";
import { FluxDispatcher, LocaleStore, MaskedLink } from "@webpack/common";

import poweredByDarkBg from "file://assets/poweredBy-dark.png?base64";
import poweredByLightBg from "file://assets/poweredBy-light.png?base64";

// My Personal API Key (place your own because mine would run out of requests)
const GIPHY_KEY = "oTYJsWrWGnaWjKKxgGzH90StXmdmQYrV";
const GIPHY_HOME = "https://giphy.com/";
const cl = classNameFactory("vc-giphy-");
const POWERED_BY_DARK = `data:image/png;base64,${poweredByDarkBg}`;
const POWERED_BY_LIGHT = `data:image/png;base64,${poweredByLightBg}`;

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

function pickUrl(...candidates: Array<string | undefined>): string | undefined {
    return candidates.find(u => !!u);
}

function toDiscordGif(item: GiphyResult): DiscordGif | null {
    const { images } = item;
    if (!images) return null;

    const gif = pickImage(images, "fixed_height", "fixed_width", "downsized", "downsized_medium", "original");
    const video = pickImage(images, "fixed_height", "fixed_width", "downsized_small", "original", "preview");
    const still = pickImage(images, "fixed_height_still", "fixed_width_still", "preview_gif", "original_still", "downsized_still");

    const gifUrl = pickUrl(gif?.url, images.original?.url);
    if (!gifUrl) return null;

    // Linux: Discord forces IMAGE format (tinywebp) and loads src via <img>.
    // Elsewhere: VIDEO format and <video> — mp4 works. mp4 as src on Linux never loads.
    const webpUrl = pickUrl(
        gif?.webp,
        video?.webp,
        images.fixed_height?.webp,
        images.fixed_width?.webp,
        images.preview_webp?.url,
    );
    const mp4Url = pickUrl(video?.mp4, images.fixed_height?.mp4, images.original?.mp4, images.preview?.mp4);

    const srcUrl = IS_LINUX
        ? pickUrl(webpUrl, gifUrl)
        : pickUrl(mp4Url, webpUrl, gifUrl);
    if (!srcUrl) return null;

    const previewUrl = pickUrl(still?.url, webpUrl, gifUrl) ?? gifUrl;
    const dimSource = IS_LINUX ? (gif ?? video) : (video ?? gif);
    const width = Number(dimSource?.width || gif?.width || video?.width || 0);
    const height = Number(dimSource?.height || gif?.height || video?.height || 0);
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
    authors: [{ name: "Scarlett 🎀", id: 1217564834825109604 }],

    patches: [
        {
            find: "renderHeaderContent()",
            replacement: [
                {
                    match: /placeholder:(\i),"aria-label":(\i)/,
                    replace: 'placeholder:$1?.replace(/Tenor|Klipy/gi,"Giphy"),"aria-label":$2?.replace(/Tenor|Klipy/gi,"Giphy")'
                },
                {
                    match: /role:"tabpanel","aria-labelledby":(\i\.\i),className:(\i)\(\)\((\i\.\i),(\i)\)/,
                    replace: 'role:"tabpanel","aria-labelledby":$1,className:$2()($3,$4,"vc-giphy-panel")'
                },
                {
                    match: /children:this\.renderContent\(\)\}\)\]/,
                    replace: "children:this.renderContent()}),$self.renderAttribution()]"
                }
            ]
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

    renderAttribution: ErrorBoundary.wrap(() => {
        const src = getTheme() === Theme.Light ? POWERED_BY_LIGHT : POWERED_BY_DARK;

        return (
            <MaskedLink
                className={cl("attribution")}
                href={GIPHY_HOME}
                title="Powered by GIPHY"
            >
                <img
                    className={cl("attribution-logo")}
                    src={src}
                    alt="Powered by GIPHY"
                    draggable={false}
                />
            </MaskedLink>
        );
    }, { noop: true }),

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
