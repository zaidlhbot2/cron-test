// extractor.js - مستخرج مسلسلات وحلقات رمضان 2026 (آخر موسم فقط)
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
    BASE_URL: 'https://laroza.lol',
    CATEGORY: 'ramadan-2026',
    PROXIES: [
        'https://api.codetabs.com/v1/proxy?quest=',
        'https://corsproxy.io/?',
        'https://api.allorigins.win/raw?url=',
        'https://cors-anywhere.herokuapp.com/',
        ''
    ],
    EPISODES_PER_FILE: 500,
    DATA_DIR: path.join(__dirname, 'data', 'Ramdan'),
    SERIES_DIR: 'series',
    ECLIPS_DIR: 'eclips',
    REQUEST_DELAY: 2000,
    MAX_RETRIES: 3
};

class ProgressTracker {
    constructor(dataDir) {
        this.filePath = path.join(dataDir, 'progress.json');
        this.data = null;
    }

    async load() {
        try {
            const content = await fs.readFile(this.filePath, 'utf-8');
            this.data = JSON.parse(content);
        } catch (error) {
            this.data = {
                last_scan: null,
                series: {},
                all_episodes: {},
                statistics: {
                    total_series: 0,
                    total_episodes: 0,
                    first_scan: true
                }
            };
        }
        return this.data;
    }

    async save() {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2));
    }

    isFirstScan() {
        return !this.data.last_scan;
    }

    isEpisodeNew(episodeId) {
        return !this.data.all_episodes || !this.data.all_episodes[episodeId];
    }

    markEpisodeExtracted(seriesId, episodeId, episodeData) {
        if (!this.data.all_episodes) {
            this.data.all_episodes = {};
        }
        
        this.data.all_episodes[episodeId] = {
            series_id: seriesId,
            extracted_at: new Date().toISOString(),
            title: episodeData.title,
            number: episodeData.number,
            season: episodeData.season
        };
        
        if (!this.data.series[seriesId]) {
            this.data.series[seriesId] = {
                last_episode: null,
                last_season: 1,
                episodes: {}
            };
        }
        
        this.data.series[seriesId].episodes[episodeId] = {
            extracted_at: new Date().toISOString(),
            title: episodeData.title,
            number: episodeData.number,
            season: episodeData.season
        };
        
        const currentLast = this.data.series[seriesId].last_episode;
        if (!currentLast || (episodeData.number && episodeData.number > (this.data.series[seriesId].episodes[currentLast]?.number || 0))) {
            this.data.series[seriesId].last_episode = episodeId;
            this.data.series[seriesId].last_season = episodeData.season;
        }
        
        this.data.last_scan = new Date().toISOString();
    }

    getLastEpisodeForSeries(seriesId) {
        return this.data.series[seriesId]?.last_episode || null;
    }

    getLastEpisodeNumber(seriesId) {
        const lastEpisodeId = this.getLastEpisodeForSeries(seriesId);
        if (lastEpisodeId && this.data.series[seriesId]?.episodes[lastEpisodeId]) {
            return this.data.series[seriesId].episodes[lastEpisodeId].number;
        }
        return 0;
    }
}

class SeriesExtractor {
    constructor(progressTracker) {
        this.progress = progressTracker;
        this.seriesList = [];
        this.newEpisodes = [];
        this.allEpisodes = [];
        this.isFirstScan = progressTracker.isFirstScan();
        this.processedSeries = new Set();
    }

    async fetch(url, retryCount = 0) {
        for (const proxy of CONFIG.PROXIES) {
            try {
                const fetchUrl = proxy ? proxy + encodeURIComponent(url) : url;
                
                const response = await axios({
                    method: 'get',
                    url: fetchUrl,
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8'
                    },
                    maxRedirects: 5,
                    validateStatus: status => status < 400
                });
                
                if (response.data && typeof response.data === 'string' && response.data.length > 500) {
                    return response.data;
                }
            } catch (e) {
                continue;
            }
        }
        
        if (retryCount < CONFIG.MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            return this.fetch(url, retryCount + 1);
        }
        
        throw new Error(`فشل الاتصال بـ ${url}`);
    }

    extractEpisodeNumber(title) {
        const patterns = [
            /الحلقة\s*(\d+)/i,
            /حلقة\s*(\d+)/i,
            /episode\s*(\d+)/i,
            /(\d+)\s*الاولى|الثانية|الثالثة|الرابعة|الخامسة|السادسة|السابعة|الثامنة|التاسعة|العاشرة/i,
            /(\d+)/ // آخر خيار
        ];
        
        for (let pattern of patterns) {
            const match = title.match(pattern);
            if (match) return parseInt(match[1]);
        }
        
        return null;
    }

    extractSeriesId(link) {
        const match = link.match(/[?&]ser=([a-f0-9]+)/i) || 
                     link.match(/serie1\.php\?ser=([a-f0-9]+)/i) ||
                     link.match(/ser=([a-f0-9]+)/i);
        
        return match ? match[1] : null;
    }

    extractEpisodeId(link) {
        const match = link.match(/[?&]vid=([a-f0-9]+)/i) || 
                     link.match(/video\.php\?vid=([a-f0-9]+)/i) ||
                     link.match(/vid=([a-f0-9]+)/i);
        
        return match ? match[1] : null;
    }

    fixImage(url) {
        if (!url) return '';
        
        if (url.startsWith('//')) {
            return 'https:' + url;
        }
        
        if (url.startsWith('/')) {
            return CONFIG.BASE_URL + url;
        }
        
        if (!url.startsWith('http')) {
            return CONFIG.BASE_URL + '/' + url;
        }
        
        if (url.startsWith('http://')) {
            url = url.replace('http://', 'https://');
        }
        
        return url;
    }

    // استخراج جميع المسلسلات
    async extractAllSeries() {
        console.log('\n🔍 جاري استخراج المسلسلات...');
        
        const allSeries = new Map();
        
        try {
            const pageUrl = `${CONFIG.BASE_URL}/category.php?cat=${CONFIG.CATEGORY}&order=DESC`;
            const html = await this.fetch(pageUrl);
            const $ = cheerio.load(html);
            
            $('a.icon-link[href*="view-serie1.php"]').each((i, el) => {
                const link = $(el).attr('href');
                const title = $(el).text().trim();
                const seriesId = this.extractSeriesId(link);
                
                if (seriesId && title) {
                    allSeries.set(seriesId, {
                        id: seriesId,
                        title: title,
                        image: '',
                        seasons: 1,
                        last_season: 1,
                        last_update: new Date().toISOString(),
                        episodes_count: 0
                    });
                }
            });
            
        } catch (error) {
            console.log(`⚠️ خطأ في استخراج المسلسلات: ${error.message}`);
        }
        
        console.log(`✅ تم العثور على ${allSeries.size} مسلسل`);
        this.seriesList = Array.from(allSeries.values());
        return this.seriesList;
    }

    // استخراج رقم آخر موسم من صفحة المسلسل
    async extractLastSeasonNumber(series) {
        try {
            const seriesUrl = `${CONFIG.BASE_URL}/view-serie1.php?ser=${series.id}`;
            const html = await this.fetch(seriesUrl);
            const $ = cheerio.load(html);
            
            // استخراج العنوان الكامل
            const fullTitle = $('h1.title').first().text().trim();
            if (fullTitle) {
                series.title = fullTitle;
            }
            
            // البحث عن كل المواسم
            const seasons = new Set();
            
            // 1. البحث في عناصر التبويب (tabs)
            $('.Tab button.tablinks, .seasons button, [class*="season"] button, .tab button').each((i, el) => {
                const seasonText = $(el).text().trim();
                const match = seasonText.match(/\d+/);
                if (match) {
                    seasons.add(parseInt(match[0]));
                }
            });
            
            // 2. البحث في الـ divs ذات الـ IDs (Season1, Season2, ...)
            $('div[id^="Season"], div[id^="season"], div[class*="season"]').each((i, el) => {
                const id = $(el).attr('id') || '';
                const match = id.match(/Season(\d+)/i) || id.match(/season(\d+)/i);
                if (match) {
                    seasons.add(parseInt(match[1]));
                }
            });
            
            // 3. البحث في روابط المواسم
            $('a[href*="#Season"], a[href*="#season"]').each((i, el) => {
                const href = $(el).attr('href') || '';
                const match = href.match(/#Season(\d+)/i) || href.match(/#season(\d+)/i);
                if (match) {
                    seasons.add(parseInt(match[1]));
                }
            });
            
            let lastSeason = 1;
            if (seasons.size > 0) {
                lastSeason = Math.max(...seasons);
                series.seasons = seasons.size;
                series.last_season = lastSeason;
                console.log(`   📺 المسلسل فيه ${seasons.size} مواسم, آخر موسم هو ${lastSeason}`);
            } else {
                console.log(`   📺 المسلسل موسم واحد`);
            }
            
            return lastSeason;
            
        } catch (error) {
            console.log(`   ⚠️ خطأ في استخراج المواسم: ${error.message}`);
            return 1;
        }
    }

    // استخراج حلقات موسم معين
    async extractEpisodesFromSeason(series, seasonNumber) {
        console.log(`   🔍 جاري استخراج حلقات الموسم ${seasonNumber}...`);
        
        try {
            // الرابط مع تحديد الموسم
            const seasonUrl = `${CONFIG.BASE_URL}/view-serie1.php?ser=${series.id}&season=${seasonNumber}`;
            const html = await this.fetch(seasonUrl);
            const $ = cheerio.load(html);
            
            const episodes = [];
            let firstEpisodeImage = '';
            
            // البحث في محتوى الموسم المحدد (إذا كان موجود في الصفحة)
            let seasonHtml = html;
            const seasonDiv = $(`#Season${seasonNumber}, #season${seasonNumber}, div[class*="season-${seasonNumber}"]`).first();
            if (seasonDiv.length > 0) {
                seasonHtml = seasonDiv.html() || html;
                const $season = cheerio.load(seasonHtml);
                
                // استخراج الحلقات من الموسم
                this.extractEpisodesFromHtml($season, series, seasonNumber, episodes, (img) => {
                    if (!firstEpisodeImage && img) firstEpisodeImage = img;
                });
            } else {
                // إذا ما لقينا الموسم المحدد، نستخرج من الصفحة كلها
                this.extractEpisodesFromHtml($, series, seasonNumber, episodes, (img) => {
                    if (!firstEpisodeImage && img) firstEpisodeImage = img;
                });
            }
            
            // ترتيب الحلقات تصاعدياً
            episodes.sort((a, b) => (a.number || 0) - (b.number || 0));
            
            console.log(`   📥 تم العثور على ${episodes.length} حلقة في الموسم ${seasonNumber}`);
            
            return {
                episodes,
                firstEpisodeImage
            };
            
        } catch (error) {
            console.log(`   ❌ خطأ في استخراج حلقات الموسم: ${error.message}`);
            return { episodes: [], firstEpisodeImage: '' };
        }
    }

    // دالة مساعدة لاستخراج الحلقات من HTML
    extractEpisodesFromHtml($, series, seasonNumber, episodes, setFirstImage) {
        // هيكل 1: li.col-xs-6 مع thumbnail (الهيكل الجديد)
        $('li.col-xs-6 .thumbnail, li.col-sm-4 .thumbnail, li.col-md-3 .thumbnail').each((i, el) => {
            const $el = $(el);
            
            const linkEl = $el.find('a[href*="video.php"]').first();
            const link = linkEl.attr('href');
            if (!link) return;
            
            const fullLink = link.startsWith('http') ? link : CONFIG.BASE_URL + (link.startsWith('/') ? link : '/' + link);
            const episodeId = this.extractEpisodeId(link);
            if (!episodeId) return;
            
            const title = $el.find('h3 a.ellipsis').text().trim() || 
                         $el.find('.ellipsis').text().trim() ||
                         linkEl.attr('title') ||
                         'حلقة';
            
            const image = $el.find('img').attr('src') || 
                         $el.find('img').attr('data-src') || 
                         $el.find('img').attr('data-original') || 
                         '';
            
            if (image && !image.includes('blank.gif') && !image.includes('data:image')) {
                if (i === 0) setFirstImage(image);
            }
            
            const episodeNumber = this.extractEpisodeNumber(title);
            
            episodes.push({
                id: episodeId,
                series_id: series.id,
                number: episodeNumber || (i + 1),
                title: title,
                image: this.fixImage(image),
                link: fullLink,
                season: seasonNumber,
                duration: $el.find('.duration, .pm-label-duration, .time').first().text().trim() || '00:00',
                servers: [],
                extracted_at: new Date().toISOString()
            });
        });

        // هيكل 2: الهيكل القديم (thumbnail, post, etc)
        if (episodes.length === 0) {
            $('.thumbnail, .post, .item, .video-item').each((i, el) => {
                const $el = $(el);
                
                const link = $el.find('a[href*="video.php"]').attr('href') || 
                            $el.find('a[href*="vid="]').attr('href');
                if (!link) return;
                
                const fullLink = link.startsWith('http') ? link : CONFIG.BASE_URL + (link.startsWith('/') ? link : '/' + link);
                const episodeId = this.extractEpisodeId(link);
                if (!episodeId) return;
                
                const title = $el.find('.ellipsis').text().trim() || 
                             $el.find('h3 a').text().trim() ||
                             'حلقة';
                
                const image = $el.find('img').attr('src') || 
                             $el.find('img').attr('data-src') || 
                             '';
                
                if (image && !image.includes('blank.gif') && !image.includes('data:image')) {
                    if (i === 0) setFirstImage(image);
                }
                
                const episodeNumber = this.extractEpisodeNumber(title);
                
                episodes.push({
                    id: episodeId,
                    series_id: series.id,
                    number: episodeNumber || (i + 1),
                    title: title,
                    image: this.fixImage(image),
                    link: fullLink,
                    season: seasonNumber,
                    duration: $el.find('.duration, .pm-label-duration, .time').first().text().trim() || '00:00',
                    servers: [],
                    extracted_at: new Date().toISOString()
                });
            });
        }
    }

    // استخراج السيرفرات من صفحة التشغيل
    async extractEpisodeServers(episode) {
        try {
            const playUrl = episode.link.replace('video.php', 'play.php');
            const html = await this.fetch(playUrl);
            const $ = cheerio.load(html);
            
            const servers = [];
            
            // الهيكل الجديد: WatchList مع data-embed-url
            $('.WatchList li').each((i, el) => {
                const $el = $(el);
                
                let embedUrl = $el.attr('data-embed-url');
                let serverName = $el.find('strong').text().trim();
                
                if (!embedUrl) {
                    embedUrl = $el.attr('data-src') || 
                              $el.find('a').attr('href') ||
                              $el.find('iframe').attr('src');
                }
                
                if (!serverName) {
                    serverName = $el.text().trim().split('\n')[0].trim() || `سيرفر ${i + 1}`;
                }
                
                if (embedUrl && embedUrl !== '#' && embedUrl !== 'javascript:;') {
                    if (embedUrl.startsWith('//')) embedUrl = 'https:' + embedUrl;
                    else if (!embedUrl.startsWith('http')) embedUrl = CONFIG.BASE_URL + '/' + embedUrl;
                    
                    servers.push({
                        name: serverName.replace(/[\\n\\r\\t]+/g, ' ').trim().substring(0, 30),
                        url: embedUrl
                    });
                }
            });
            
            // الهيكل القديم
            if (servers.length === 0) {
                $('.server-list li, .servers li, [class*="server"] li').each((i, el) => {
                    const $el = $(el);
                    
                    let embedUrl = $el.attr('data-embed-url') || 
                                  $el.attr('data-src') || 
                                  $el.find('a').attr('href') ||
                                  $el.find('iframe').attr('src');
                    
                    if (embedUrl && embedUrl !== '#' && embedUrl !== 'javascript:;') {
                        let serverName = $el.find('strong').text().trim() || 
                                        $el.find('.name').text().trim() || 
                                        $el.text().trim().split('\n')[0].trim() ||
                                        `سيرفر ${i + 1}`;
                        
                        if (embedUrl.startsWith('//')) embedUrl = 'https:' + embedUrl;
                        else if (!embedUrl.startsWith('http')) embedUrl = CONFIG.BASE_URL + '/' + embedUrl;
                        
                        servers.push({
                            name: serverName.replace(/[\\n\\r\\t]+/g, ' ').trim().substring(0, 30),
                            url: embedUrl
                        });
                    }
                });
            }
            
            episode.servers = servers;
            console.log(`         📺 ${servers.length} سيرفر`);
            
        } catch (e) {
            console.log(`         ⚠️ فشل استخراج السيرفرات: ${e.message}`);
            episode.servers = [];
        }
    }

    // معالجة مسلسل واحد
    async processSeries(series) {
        if (this.processedSeries.has(series.id)) {
            console.log(`\n⏭️ تخطي مسلسل (تمت معالجته مسبقاً): ${series.title}`);
            return;
        }
        
        console.log(`\n🎬 معالجة مسلسل: ${series.title}`);
        
        try {
            // 1. استخراج رقم آخر موسم
            const lastSeason = await this.extractLastSeasonNumber(series);
            
            // 2. استخراج حلقات آخر موسم فقط
            const { episodes, firstEpisodeImage } = await this.extractEpisodesFromSeason(series, lastSeason);
            
            if (episodes.length === 0) {
                console.log(`   ❌ لم نتمكن من استخراج أي حلقة للموسم ${lastSeason}`);
                return;
            }
            
            // تعيين صورة المسلسل
            if (!series.image && firstEpisodeImage) {
                series.image = this.fixImage(firstEpisodeImage);
            }
            
            series.episodes_count = episodes.length;
            
            // معرفة آخر حلقة استخرجناها سابقاً
            const lastEpisodeNumber = this.progress.getLastEpisodeNumber(series.id);
            console.log(`   📊 آخر حلقة محفوظة: ${lastEpisodeNumber || 'لا يوجد'}`);
            
            // معالجة كل حلقة
            for (let i = 0; i < episodes.length; i++) {
                const episode = episodes[i];
                
                const isNew = this.progress.isEpisodeNew(episode.id);
                
                if (isNew) {
                    if (this.isFirstScan || !lastEpisodeNumber || (episode.number && episode.number > lastEpisodeNumber)) {
                        console.log(`      🔄 [جديد] ${episode.title.substring(0, 50)}...`);
                        
                        await this.extractEpisodeServers(episode);
                        
                        this.newEpisodes.push(episode);
                        this.progress.markEpisodeExtracted(series.id, episode.id, episode);
                        
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } else {
                        console.log(`      ⏭️ [تخطي] ${episode.title.substring(0, 40)}... (أقدم من آخر حلقة)`);
                    }
                } else {
                    console.log(`      ✅ [موجود] ${episode.title.substring(0, 40)}...`);
                }
            }
            
            this.processedSeries.add(series.id);
            
        } catch (error) {
            console.log(`   ❌ خطأ في معالجة المسلسل: ${error.message}`);
        }
    }

    // تحميل جميع الحلقات الموجودة
    async loadAllEpisodes() {
        const eclipsDir = path.join(CONFIG.DATA_DIR, CONFIG.ECLIPS_DIR);
        
        try {
            const files = await fs.readdir(eclipsDir);
            const episodeFiles = files.filter(f => f.startsWith('page') && f.endsWith('.json') && f !== 'Home.json');
            
            for (const file of episodeFiles) {
                try {
                    const content = await fs.readFile(path.join(eclipsDir, file), 'utf-8');
                    const data = JSON.parse(content);
                    if (data.episodes && Array.isArray(data.episodes)) {
                        this.allEpisodes = this.allEpisodes.concat(data.episodes);
                    }
                } catch (e) {
                    console.log(`⚠️ خطأ في قراءة ${file}`);
                }
            }
            
            console.log(`📚 تم تحميل ${this.allEpisodes.length} حلقة موجودة`);
        } catch (e) {
            console.log('📭 لا توجد حلقات سابقة');
        }
    }

    // حفظ أحدث 10 حلقات
    async saveLatestEpisodesHome() {
        const eclipsDir = path.join(CONFIG.DATA_DIR, CONFIG.ECLIPS_DIR);
        await fs.mkdir(eclipsDir, { recursive: true });
        
        let allEpisodesForHome = [...this.allEpisodes, ...this.newEpisodes];
        allEpisodesForHome.sort((a, b) => new Date(b.extracted_at) - new Date(a.extracted_at));
        
        const uniqueEpisodes = [];
        const seenIds = new Set();
        
        for (const ep of allEpisodesForHome) {
            if (!seenIds.has(ep.id)) {
                seenIds.add(ep.id);
                uniqueEpisodes.push(ep);
            }
            if (uniqueEpisodes.length >= 10) break;
        }
        
        const latest10 = uniqueEpisodes.map(ep => {
            const series = this.seriesList.find(s => s.id === ep.series_id);
            return {
                id: ep.id,
                series_id: ep.series_id,
                series_title: series?.title || 'مسلسل',
                number: ep.number,
                title: ep.title,
                image: ep.image,
                season: ep.season,
                servers: ep.servers || [],
                extracted_at: ep.extracted_at
            };
        });
        
        const filePath = path.join(eclipsDir, 'Home.json');
        const data = {
            last_update: new Date().toISOString(),
            total: latest10.length,
            episodes: latest10
        };
        
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
        console.log(`🏠 تم حفظ آخر 10 حلقات في eclips/Home.json`);
    }

    // حفظ المسلسلات
    async saveSeriesHome() {
        const seriesDir = path.join(CONFIG.DATA_DIR, CONFIG.SERIES_DIR);
        await fs.mkdir(seriesDir, { recursive: true });
        
        const filePath = path.join(seriesDir, 'Home.json');
        
        const sortedSeries = [...this.seriesList].sort((a, b) => a.title.localeCompare(b.title, 'ar'));
        
        const cleanSeries = sortedSeries.map(s => ({
            id: s.id,
            title: s.title,
            image: s.image,
            seasons: s.seasons || 1,
            last_season: s.last_season || 1,
            episodes_count: s.episodes_count || 0
        }));
        
        const data = {
            last_update: new Date().toISOString(),
            total_series: cleanSeries.length,
            series: cleanSeries
        };
        
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
        console.log(`✅ تم حفظ ${cleanSeries.length} مسلسل في series/Home.json`);
    }

    // حفظ جميع الحلقات في ملفات
    async saveAllEpisodes() {
        const eclipsDir = path.join(CONFIG.DATA_DIR, CONFIG.ECLIPS_DIR);
        await fs.mkdir(eclipsDir, { recursive: true });
        
        const allEpisodesMap = new Map();
        
        for (const ep of this.allEpisodes) {
            allEpisodesMap.set(ep.id, ep);
        }
        
        for (const ep of this.newEpisodes) {
            allEpisodesMap.set(ep.id, ep);
        }
        
        let allEpisodes = Array.from(allEpisodesMap.values());
        allEpisodes.sort((a, b) => new Date(b.extracted_at) - new Date(a.extracted_at));
        
        const files = await fs.readdir(eclipsDir).catch(() => []);
        for (const file of files) {
            if (file.startsWith('page') && file.endsWith('.json') && file !== 'Home.json') {
                await fs.unlink(path.join(eclipsDir, file)).catch(() => {});
            }
        }
        
        const pages = Math.ceil(allEpisodes.length / CONFIG.EPISODES_PER_FILE);
        
        for (let page = 1; page <= pages; page++) {
            const start = (page - 1) * CONFIG.EPISODES_PER_FILE;
            const end = start + CONFIG.EPISODES_PER_FILE;
            const pageEpisodes = allEpisodes.slice(start, end);
            
            const cleanEpisodes = pageEpisodes.map(ep => ({
                id: ep.id,
                series_id: ep.series_id,
                number: ep.number,
                title: ep.title,
                image: ep.image,
                link: ep.link,
                season: ep.season,
                duration: ep.duration,
                servers: ep.servers || [],
                extracted_at: ep.extracted_at
            }));
            
            const filePath = path.join(eclipsDir, `page${page}.json`);
            const data = {
                page: page,
                total_pages: pages,
                total_episodes: allEpisodes.length,
                episodes_in_page: cleanEpisodes.length,
                last_update: new Date().toISOString(),
                episodes: cleanEpisodes
            };
            
            await fs.writeFile(filePath, JSON.stringify(data, null, 2));
            console.log(`📄 eclips/page${page}.json - ${cleanEpisodes.length} حلقة`);
        }
        
        console.log(`✅ تم توزيع ${allEpisodes.length} حلقة على ${pages} ملفات`);
    }

    // تحديث الإحصائيات
    async updateStatistics() {
        const totalSeries = this.seriesList.length;
        
        const allEpisodesMap = new Map();
        for (const ep of this.allEpisodes) allEpisodesMap.set(ep.id, ep);
        for (const ep of this.newEpisodes) allEpisodesMap.set(ep.id, ep);
        const totalEpisodes = allEpisodesMap.size;
        
        const allEpisodesForLatest = Array.from(allEpisodesMap.values());
        allEpisodesForLatest.sort((a, b) => new Date(b.extracted_at) - new Date(a.extracted_at));
        
        const latestEpisodes = allEpisodesForLatest.slice(0, 10).map(ep => ({
            id: ep.id,
            series_id: ep.series_id,
            series_title: this.seriesList.find(s => s.id === ep.series_id)?.title || '',
            title: ep.title,
            image: ep.image,
            number: ep.number,
            season: ep.season,
            added_at: ep.extracted_at
        }));
        
        const latestSeries = this.seriesList
            .sort((a, b) => new Date(b.last_update) - new Date(a.last_update))
            .slice(0, 5)
            .map(s => ({
                id: s.id,
                title: s.title,
                image: s.image,
                added_at: s.last_update
            }));
        
        this.progress.data.statistics = {
            total_series: totalSeries,
            total_episodes: totalEpisodes,
            new_episodes_today: this.newEpisodes.length,
            last_scan: new Date().toISOString(),
            first_scan: false
        };
        
        this.progress.data.latest_episodes = latestEpisodes;
        this.progress.data.latest_series = latestSeries;
        
        await this.progress.save();
    }

    // تشغيل الاستخراج الكامل
    async run() {
        console.log('='.repeat(60));
        console.log('🎬 مستخرج مسلسلات وحلقات رمضان 2026 (آخر موسم فقط)');
        if (this.isFirstScan) {
            console.log('📌 هذه هي المرة الأولى - سيتم استخراج كل الحلقات');
        } else {
            console.log('📌 تشغيل تحديث - سيتم استخراج الحلقات الجديدة فقط');
        }
        console.log('='.repeat(60));
        
        await this.loadAllEpisodes();
        await this.extractAllSeries();
        
        console.log('\n' + '='.repeat(60));
        console.log('🔄 جاري معالجة المسلسلات واستخراج آخر موسم...');
        console.log('='.repeat(60));
        
        for (let i = 0; i < this.seriesList.length; i++) {
            const series = this.seriesList[i];
            console.log(`\n[${i + 1}/${this.seriesList.length}]`);
            await this.processSeries(series);
            
            if (i < this.seriesList.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        await this.saveSeriesHome();
        await this.saveAllEpisodes();
        await this.saveLatestEpisodesHome();
        await this.updateStatistics();
        this.printReport();
    }

    printReport() {
        console.log('\n' + '='.repeat(60));
        console.log('📊 تقرير اليوم:');
        console.log('='.repeat(60));
        console.log(`📁 المسلسلات: ${this.seriesList.length} مسلسل`);
        console.log(`🆕 الحلقات الجديدة اليوم: ${this.newEpisodes.length} حلقة`);
        
        const allEpisodesMap = new Map();
        for (const ep of this.allEpisodes) allEpisodesMap.set(ep.id, ep);
        for (const ep of this.newEpisodes) allEpisodesMap.set(ep.id, ep);
        
        console.log(`📚 إجمالي الحلقات: ${allEpisodesMap.size} حلقة`);
        
        if (this.newEpisodes.length > 0) {
            console.log('\n📋 الحلقات الجديدة:');
            this.newEpisodes.slice(0, 5).forEach((ep, i) => {
                const series = this.seriesList.find(s => s.id === ep.series_id);
                console.log(`   ${i + 1}. ${series?.title || 'مسلسل'} - الحلقة ${ep.number || ''}`);
            });
            
            if (this.newEpisodes.length > 5) {
                console.log(`   ... و${this.newEpisodes.length - 5} حلقات أخرى`);
            }
        }
        
        console.log('\n✅ تم الانتهاء بنجاح!');
        console.log('='.repeat(60));
    }
}

// ========== التشغيل الرئيسي ==========
(async () => {
    try {
        await fs.mkdir(path.join(CONFIG.DATA_DIR, CONFIG.SERIES_DIR), { recursive: true });
        await fs.mkdir(path.join(CONFIG.DATA_DIR, CONFIG.ECLIPS_DIR), { recursive: true });
        
        const progress = new ProgressTracker(CONFIG.DATA_DIR);
        await progress.load();
        
        const extractor = new SeriesExtractor(progress);
        await extractor.run();
        
    } catch (error) {
        console.error('\n❌ خطأ:', error.message);
        process.exit(1);
    }
})();
