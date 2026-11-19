(function() {
    /**
     * @typedef {Object} Response
     * @property {boolean} success
     * @property {any} [data]
     * @property {string} [errorCode]
     * @property {string} [message]
     */

    /**
     * @type {import('@skystream/sdk').Manifest}
     */
    // var manifest is injected at runtime

    const DEFAULT_BASE_URL = "http://new.circleftp.net:5000";

    function getBaseUrl() {
        if (typeof manifest !== "undefined" && manifest && manifest.baseUrl) {
            return String(manifest.baseUrl).replace(/\/+$/, "");
        }
        return DEFAULT_BASE_URL;
    }

    const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
    const HEADERS = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/html, */*"
    };

    /**
     * Native HTTP GET using SkyStream's http_get bridge
     */
    async function _fetch(url) {
        if (typeof http_get === "function") {
            const res = await http_get(url, {
                ...HEADERS,
                headers: HEADERS
            });
            return res?.body || "";
        } else if (typeof axios !== "undefined" && axios && typeof axios.get === "function") {
            const res = await axios.get(url, {
                headers: HEADERS,
                timeout: 15000
            });
            return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
        } else if (typeof fetch !== "undefined") {
            const res = await fetch(url, {
                headers: HEADERS
            });
            return await res.text();
        }
        throw new Error("No HTTP client (http_get) available in SkyStream runtime");
    }

    /**
     * Safe JSON fetch helper
     */
    async function fetchJson(url) {
        const body = await _fetch(url);
        if (!body) return null;
        if (typeof body === "object") return body;
        try {
            return JSON.parse(body);
        } catch (e) {
            console.error("JSON parse error for " + url + ": " + e.message);
            return null;
        }
    }

    /**
     * Helper to clean titles from raw torrent/file names
     */
    function cleanTitle(title, name) {
        let text = (name && name.trim()) ? name.trim() : (title || "").trim();
        text = text.replace(/\.(mkv|mp4|avi|webm|ts|m4v)$/i, "");
        text = text.replace(/(\[\s*VR\d+\s*\]|\b(x264|x265|hevc|h264|bluray|webrip|web-dl|dvdrip|1080p|720p|480p|4k|uhd)\b.*$)/i, "");
        text = text.replace(/[._]/g, " ").trim();
        return text || title || "Unknown";
    }

    /**
     * Resolves absolute image URL from CircleFTP
     */
    function resolveImageUrl(baseUrl, imagePath) {
        if (!imagePath) return undefined;
        if (imagePath.startsWith("http://") || imagePath.startsWith("https://")) {
            return imagePath;
        }
        return `${baseUrl}/uploads/${imagePath}`;
    }

    /**
     * Parses numeric year from strings like "2026" or "2008-2013"
     */
    function parseYear(yearStr) {
        if (!yearStr) return undefined;
        const match = String(yearStr).match(/\b(19\d\d|20\d\d)\b/);
        return match ? parseInt(match[1], 10) : undefined;
    }

    /**
     * Parses duration string into minutes (e.g. "2h 15m" -> 135)
     */
    function parseDuration(watchTime) {
        if (!watchTime) return undefined;
        const str = String(watchTime).toLowerCase().trim();
        let total = 0;
        const hoursMatch = str.match(/(\d+)\s*h/);
        const minsMatch = str.match(/(\d+)\s*m/);

        if (hoursMatch) total += parseInt(hoursMatch[1], 10) * 60;
        if (minsMatch) total += parseInt(minsMatch[1], 10);

        if (total === 0) {
            const rawNumber = parseInt(str, 10);
            if (!isNaN(rawNumber) && rawNumber > 0) return rawNumber;
        }

        return total > 0 ? total : undefined;
    }

    /**
     * Detects dub / dual-audio status
     */
    function detectDubStatus(post) {
        const check = `${post.title || ""} ${post.name || ""} ${post.quality || ""} ${post.tags || ""}`.toLowerCase();
        if (
            check.includes("dub") ||
            check.includes("dual audio") ||
            check.includes("multi audio") ||
            check.includes("hin+eng") ||
            check.includes("hin+tam")
        ) {
            return "dub";
        }
        return "none";
    }

    /**
     * Transforms a CircleFTP post object to a SkyStream MultimediaItem
     */
    function toMultimediaItem(post, baseUrl) {
        if (!post || (post.type !== "singleVideo" && post.type !== "series")) {
            return null;
        }

        const isSeries = post.type === "series";
        const categoryNames = Array.isArray(post.categories) 
            ? post.categories.map(c => c.name).filter(Boolean)
            : [];

        const isAnime = categoryNames.some(cat => 
            /anime/i.test(cat) || (post.title && /anime/i.test(post.title))
        );

        const type = isAnime ? "anime" : (isSeries ? "series" : "movie");
        const posterUrl = resolveImageUrl(baseUrl, post.image || post.imageSm);
        const bannerUrl = resolveImageUrl(baseUrl, post.cover);
        const title = cleanTitle(post.title, post.name);
        const year = parseYear(post.year);
        const duration = parseDuration(post.watchTime);
        const url = `${baseUrl}/api/posts/${post.id}`;

        return new MultimediaItem({
            title: title,
            url: url,
            posterUrl: posterUrl,
            bannerUrl: bannerUrl,
            type: type,
            year: year,
            duration: duration,
            description: post.metaData || undefined,
            tags: categoryNames.length > 0 ? categoryNames : undefined,
            status: isSeries ? "ongoing" : "completed",
            isAdult: false
        });
    }

    // Known post IDs with square/landscape images on CircleFTP that cause
    // SkyStream's first-item probe to prematurely flip an entire category row to landscape
    const LANDSCAPE_POST_IDS = new Set(["106417"]);

    function ensureFirstItemPortrait(items) {
        if (!items || items.length <= 1) return items;
        const firstId = extractPostId(items[0].url);
        if (firstId && LANDSCAPE_POST_IDS.has(firstId)) {
            const portraitIdx = items.findIndex(it => !LANDSCAPE_POST_IDS.has(extractPostId(it.url)));
            if (portraitIdx > 0) {
                const [item] = items.splice(portraitIdx, 1);
                items.unshift(item);
            }
        }
        return items;
    }

    /**
     * Home screen categories configuration
     */
    const HOME_CATEGORIES = [
        { id: "80", title: "Trending", limit: 12 },            // Featured Carousel
        { id: "6", title: "English Movies", limit: 12 },
        { id: "9", title: "TV Series", limit: 12 },
        { id: "22", title: "Dubbed Series & Shows", limit: 12 },
        { id: "2", title: "Hindi Movies", limit: 12 },
        { id: "3", title: "South Indian Movies", limit: 12 },
        { id: "1", title: "Animation Movies", limit: 12 },
        { id: "21", title: "Anime Series", limit: 12 },
        { id: "85", title: "Documentaries", limit: 12 }
    ];

    /**
     * Loads the home screen categories.
     * @param {(res: Response) => void} cb 
     */
    async function getHome(cb) {
        try {
            const baseUrl = getBaseUrl();
            const homeData = {};

            // Sequential iteration ensures compatibility with QuickJS Dart bridge
            for (const cat of HOME_CATEGORIES) {
                try {
                    const endpoint = `${baseUrl}/api/posts?categoryExact=${cat.id}&page=1&order=desc&limit=${cat.limit}`;
                    const json = await fetchJson(endpoint);
                    if (json && Array.isArray(json.posts)) {
                        let items = json.posts
                            .map(post => toMultimediaItem(post, baseUrl))
                            .filter(Boolean);
                        if (items.length > 0) {
                            // Ensure the first item is portrait so SkyStream probe
                            // keeps the row in portrait orientation
                            items = ensureFirstItemPortrait(items);
                            homeData[cat.title] = items;
                        }
                    }
                } catch (catErr) {
                    console.error("Failed loading category " + cat.title + ": " + (catErr.message || catErr));
                }
            }

            cb({
                success: true,
                data: homeData
            });
        } catch (e) {
            cb({
                success: false,
                errorCode: "PARSE_ERROR",
                message: e ? (e.message || String(e)) : "Unknown error in getHome"
            });
        }
    }

    /**
     * Searches for media items.
     * @param {string} query
     * @param {(res: Response) => void} cb 
     */
    async function search(query, cb) {
        try {
            const baseUrl = getBaseUrl();
            const endpoint = `${baseUrl}/api/posts?searchTerm=${encodeURIComponent(query)}&order=desc&limit=30`;
            const json = await fetchJson(endpoint);

            let items = [];
            if (json && Array.isArray(json.posts)) {
                items = json.posts
                    .map(post => toMultimediaItem(post, baseUrl))
                    .filter(Boolean);
            }

            cb({
                success: true,
                data: items
            });
        } catch (e) {
            cb({
                success: false,
                errorCode: "SEARCH_ERROR",
                message: e ? (e.message || String(e)) : "Unknown error in search"
            });
        }
    }

    /**
     * Extracts post ID from various URL representations
     */
    function extractPostId(url) {
        if (!url) return null;
        if (/^\d+$/.test(url)) return url;
        const postMatch = url.match(/\/posts\/(\d+)/i);
        if (postMatch) return postMatch[1];
        const contentMatch = url.match(/\/content\/(\d+)/i);
        if (contentMatch) return contentMatch[1];
        const endDigits = url.match(/(\d+)(?:\/?$|\?)/);
        if (endDigits) return endDigits[1];
        return null;
    }

    /**
     * Loads details for a specific media item.
     * @param {string} url
     * @param {(res: Response) => void} cb 
     */
    async function load(url, cb) {
        try {
            const baseUrl = getBaseUrl();
            const postId = extractPostId(url);
            if (!postId) {
                return cb({
                    success: false,
                    errorCode: "INVALID_URL",
                    message: `Could not parse valid CircleFTP post ID from: ${url}`
                });
            }

            const post = await fetchJson(`${baseUrl}/api/posts/${postId}`);
            if (!post || !post.id) {
                return cb({
                    success: false,
                    errorCode: "NOT_FOUND",
                    message: `Media item ${postId} not found`
                });
            }

            const isSeries = post.type === "series";
            const categoryNames = Array.isArray(post.categories) 
                ? post.categories.map(c => c.name).filter(Boolean)
                : [];

            const isAnime = categoryNames.some(cat => 
                /anime/i.test(cat) || (post.title && /anime/i.test(post.title))
            );

            const type = isAnime ? "anime" : (isSeries ? "series" : "movie");
            const posterUrl = resolveImageUrl(baseUrl, post.image || post.imageSm);
            const bannerUrl = resolveImageUrl(baseUrl, post.cover);
            const title = cleanTitle(post.title, post.name);
            const year = parseYear(post.year);
            const duration = parseDuration(post.watchTime);
            const dubStatus = detectDubStatus(post);
            const qualityBadge = (post.quality && post.quality.trim()) ? post.quality.trim() : "HD";

            if (!isSeries) {
                // Movie / Single Video
                const directVideoUrl = post.content || "";
                const instantStreams = directVideoUrl ? [
                    new StreamResult({
                        url: directVideoUrl,
                        source: "Circle FTP",
                        quality: qualityBadge
                    })
                ] : [];

                const movieItem = new MultimediaItem({
                    title: title,
                    url: `${baseUrl}/api/posts/${post.id}`,
                    posterUrl: posterUrl,
                    bannerUrl: bannerUrl,
                    type: type,
                    year: year,
                    duration: duration,
                    description: post.metaData || undefined,
                    tags: categoryNames.length > 0 ? categoryNames : undefined,
                    status: "completed",
                    isAdult: false,
                    streams: instantStreams
                });

                return cb({
                    success: true,
                    data: movieItem
                });
            } else {
                // TV Series
                const episodes = [];
                const seasonsData = Array.isArray(post.content) ? post.content : [];

                let seasonIndex = 1;
                for (const season of seasonsData) {
                    const seasonNameStr = season.seasonName || `Season ${seasonIndex}`;
                    const seasonNumMatch = seasonNameStr.match(/season\s*(\d+)/i);
                    const seasonNum = seasonNumMatch ? parseInt(seasonNumMatch[1], 10) : seasonIndex;

                    const rawEpisodes = Array.isArray(season.episodes) ? season.episodes : [];
                    let epIndex = 1;

                    for (const ep of rawEpisodes) {
                        const epTitle = ep.title || `Episode ${epIndex}`;
                        const epNumMatch = epTitle.match(/episode[:\s]*(\d+)/i);
                        const epNum = epNumMatch ? parseInt(epNumMatch[1], 10) : epIndex;
                        const streamLink = ep.link || "";

                        const epStreams = streamLink ? [
                            new StreamResult({
                                url: streamLink,
                                source: "Circle FTP",
                                quality: qualityBadge
                            })
                        ] : [];

                        episodes.push(new Episode({
                            name: epTitle,
                            url: streamLink || `${baseUrl}/api/posts/${post.id}/s${seasonNum}e${epNum}`,
                            season: seasonNum,
                            episode: epNum,
                            posterUrl: posterUrl,
                            dubStatus: dubStatus,
                            streams: epStreams
                        }));

                        epIndex++;
                    }
                    seasonIndex++;
                }

                const seriesItem = new MultimediaItem({
                    title: title,
                    url: `${baseUrl}/api/posts/${post.id}`,
                    posterUrl: posterUrl,
                    bannerUrl: bannerUrl,
                    type: type,
                    year: year,
                    duration: duration,
                    description: post.metaData || undefined,
                    tags: categoryNames.length > 0 ? categoryNames : undefined,
                    status: "ongoing",
                    isAdult: false,
                    episodes: episodes
                });

                return cb({
                    success: true,
                    data: seriesItem
                });
            }
        } catch (e) {
            cb({
                success: false,
                errorCode: "LOAD_ERROR",
                message: e ? (e.message || String(e)) : "Unknown error in load"
            });
        }
    }

    /**
     * Resolves streams for a specific media item or episode.
     * @param {string} url
     * @param {(res: Response) => void} cb 
     */
    async function loadStreams(url, cb) {
        try {
            if (!url) {
                return cb({ success: false, errorCode: "EMPTY_URL", message: "No stream URL provided" });
            }

            // If the URL is already a direct video file or FTP link
            if (/\.(mkv|mp4|avi|webm|ts|m4v)(\?.*)?$/i.test(url) || url.includes("/FILE/")) {
                return cb({
                    success: true,
                    data: [
                        new StreamResult({
                            url: url,
                            source: "Circle FTP",
                            quality: "Direct"
                        })
                    ]
                });
            }

            // If a post detail URL was passed instead, resolve from post API
            const postId = extractPostId(url);
            if (postId) {
                const baseUrl = getBaseUrl();
                const post = await fetchJson(`${baseUrl}/api/posts/${postId}`);
                if (post && post.content && typeof post.content === "string") {
                    return cb({
                        success: true,
                        data: [
                            new StreamResult({
                                url: post.content,
                                source: "Circle FTP",
                                quality: post.quality || "Direct"
                            })
                        ]
                    });
                }
            }

            // Fallback: return the URL directly
            cb({
                success: true,
                data: [
                    new StreamResult({
                        url: url,
                        source: "Circle FTP",
                        quality: "Direct"
                    })
                ]
            });
        } catch (e) {
            cb({
                success: false,
                errorCode: "STREAM_ERROR",
                message: e ? (e.message || String(e)) : "Unknown error in loadStreams"
            });
        }
    }

    // Export to global scope for SkyStream runtime
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
