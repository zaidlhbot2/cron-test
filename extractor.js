// extractor.js - مستخرج مسلسلات وحلقات رمضان 2026 (نسخة محسنة)
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
        this.processedSeries = new Set(); // لتتبع المسلسلات التي تمت معالجتها
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
            /(\d+)\s*الاولى|الثانية|الثالثة|الرابعة|الخامسة/i,
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

    // استخراج جميع حلقات المسلسل من صفحة حلقة واحدة
    async extractAllEpisodesFromAnyEpisode(series) {
        console.log(`\n🎬 محاولة استخراج جميع حلقات: ${series.title}`);
        
        try {
            // أولاً نحتاج للحصول على أي حلقة من المسلسل
            // نجرب الوصول لصفحة المسلسل أولاً
            const seriesUrl = `${CONFIG.BASE_URL}/view-serie1.php?ser=${series.id}`;
            const seriesHtml = await this.fetch(seriesUrl);
            const $series = cheerio.load(seriesHtml);
            
            // نبحث عن أول رابط حلقة في صفحة المسلسل
            let firstEpisodeLink = null;
            
            // البحث في الـ thumbnails
            $series('.thumbnail a[href*="video.php"], .post a[href*="video.php"], a[href*="video.php"]').each((i, el) => {
                if (!firstEpisodeLink) {
                    const href = $series(el).attr('href');
                    if (href && href.includes('video.php')) {
                        firstEpisodeLink = href.startsWith('http') ? href : CONFIG.BASE_URL + (href.startsWith('/') ? href : '/' + href);
                    }
                }
            });
            
            // إذا ما لقينا، نجرب نبحث في أي رابط
            if (!firstEpisodeLink) {
                $series('a[href*="vid="]').each((i, el) => {
                    if (!firstEpisodeLink) {
                        const href = $series(el).attr('href');
                        if (href) {
                            firstEpisodeLink = href.startsWith('http') ? href : CONFIG.BASE_URL + (href.startsWith('/') ? href : '/' + href);
                        }
                    }
                });
            }
            
            if (!firstEpisodeLink) {
                console.log(`   ❌ لم نتمكن من العثور على أي حلقة للمسلسل`);
                return [];
            }
            
            console.log(`   🔗 تم العثور على رابط حلقة: ${firstEpisodeLink}`);
            
            // الآن نحول الرابط إلى play.php
            const playUrl = firstEpisodeLink.replace('video.php', 'play.php');
            const playHtml = await this.fetch(playUrl);
            const $play = cheerio.load(playHtml);
            
            // البحث عن قائمة الحلقات الكاملة
            const allEpisodes = [];
            
            // الهيكل الجديد: SeasonsEpisodes
            $play('.SeasonsEpisodes a[href*="video.php"]').each((i, el) => {
                const href = $play(el).attr('href');
                const title = $play(el).attr('title') || $play(el).text();
                const episodeNumber = $play(el).find('em').text().trim() || this.extractEpisodeNumber(title);
                
                if (href) {
                    const episodeId = this.extractEpisodeId(href);
                    if (episodeId) {
                        allEpisodes.push({
                            id: episodeId,
                            series_id: series.id,
                            number: parseInt(episodeNumber) || (i + 1),
                            title: title,
                            link: href.startsWith('http') ? href : CONFIG.BASE_URL + (href.startsWith('/') ? href : '/' + href),
                            season: 1,
                            extracted_at: new Date().toISOString(),
                            servers: []
                        });
                    }
                }
            });
            
            // إذا ما لقينا بالهيكل الجديد، نبحث بالطريقة القديمة
            if (allEpisodes.length === 0) {
                $play('.thumbnail, .post, .item, .video-item, li.col-xs-6').each((i, el) => {
                    const link = $play(el).find('a[href*="video.php"]').attr('href');
                    if (link) {
                        const title = $play(el).find('.ellipsis').text().trim() || $play(el).find('h3 a').text().trim();
                        const episodeId = this.extractEpisodeId(link);
                        const episodeNumber = this.extractEpisodeNumber(title);
                        
                        if (episodeId) {
                            allEpisodes.push({
                                id: episodeId,
                                series_id: series.id,
                                number: episodeNumber || (i + 1),
                                title: title,
                                link: link.startsWith('http') ? link : CONFIG.BASE_URL + (link.startsWith('/') ? link : '/' + link),
                                season: 1,
                                extracted_at: new Date().toISOString(),
                                servers: []
                            });
                        }
                    }
                });
            }
            
            // ترتيب الحلقات حسب الرقم
            allEpisodes.sort((a, b) => (a.number || 0) - (b.number || 0));
            
            console.log(`   📥 تم العثور على ${allEpisodes.length} حلقة كاملة للمسلسل`);
            
            // نأخذ صورة المسلسل من أول حلقة إذا ممكن
            if (allEpisodes.length > 0 && !series.image) {
                const firstEpisodeLink = allEpisodes[0].link;
                const firstEpisodeHtml = await this.fetch(firstEpisodeLink);
                const $first = cheerio.load(firstEpisodeHtml);
                
                const image = $first('meta[property="og:image"]').attr('content') || 
                             $first('img.poster').attr('src') ||
                             $first('img[src*="uploads"]').first().attr('src');
                
                if (image) {
                    series.image = this.fixImage(image);
                }
            }
            
            return allEpisodes;
            
        } catch (error) {
            console.log(`   ❌ خطأ في استخراج جميع الحلقات: ${error.message}`);
            return [];
        }
    }

    // استخراج السيرفرات من صفحة التشغيل (محسنة للهيكل الجديد)
    async extractEpisodeServers(episode) {
        try {
            const playUrl = episode.link.replace('video.php', 'play.php');
            const html = await this.fetch(playUrl);
            const $ = cheerio.load(html);
            
            const servers = [];
            
            // الهيكل الجديد: WatchList مع data-embed-url
            $('.WatchList li').each((i, el) => {
                const $el = $(el);
                
                // نجرب data-embed-url أولاً
                let embedUrl = $el.attr('data-embed-url');
                let serverName = $el.find('strong').text().trim();
                
                // إذا ما لقينا data-embed-url، نجرب طرق أخرى
                if (!embedUrl) {
                    embedUrl = $el.attr('data-src') || 
                              $el.find('a').attr('href') ||
                              $el.find('iframe').attr('src');
                }
                
                // إذا ما لقينا اسم سيرفر، نستخدم النص
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
            
            // إذا ما لقينا سيرفرات بالهيكل الجديد، نجرب الطرق القديمة
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
        // نتأكد أننا ما عالجنا هذا المسلسل قبل كده
        if (this.processedSeries.has(series.id)) {
            console.log(`\n⏭️ تخطي مسلسل (تمت معالجته مسبقاً): ${series.title}`);
            return;
        }
        
        console.log(`\n🎬 معالجة مسلسل: ${series.title}`);
        
        try {
            // محاولة استخراج جميع حلقات المسلسل من أي حلقة
            const allEpisodes = await this.extractAllEpisodesFromAnyEpisode(series);
            
            if (allEpisodes.length === 0) {
                console.log(`   ❌ لم نتمكن من استخراج أي حلقة لهذا المسلسل`);
                return;
            }
            
            series.episodes_count = allEpisodes.length;
            
            // معرفة آخر حلقة استخرجناها سابقاً
            const lastEpisodeNumber = this.progress.getLastEpisodeNumber(series.id);
            console.log(`   📊 آخر حلقة محفوظة: ${lastEpisodeNumber || 'لا يوجد'}`);
            
            // معالجة كل حلقة
            for (let i = 0; i < allEpisodes.length; i++) {
                const episode = allEpisodes[i];
                
                // تحقق إذا كانت الحلقة جديدة
                const isNew = this.progress.isEpisodeNew(episode.id);
                
                if (isNew) {
                    // إذا كانت أول مرة أو الحلقة أحدث من آخر حلقة
                    if (this.isFirstScan || !lastEpisodeNumber || (episode.number && episode.number > lastEpisodeNumber)) {
                        console.log(`      🔄 [جديد] ${episode.title.substring(0, 50)}...`);
                        
                        // استخرج السيرفرات
                        await this.extractEpisodeServers(episode);
                        
                        // أضفها للحلقات الجديدة
                        this.newEpisodes.push(episode);
                        
                        // سجل في progress
                        this.progress.markEpisodeExtracted(series.id, episode.id, episode);
                        
                        // تأخير بين الحلقات
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } else {
                        console.log(`      ⏭️ [تخطي] ${episode.title.substring(0, 40)}... (أقدم من آخر حلقة)`);
                    }
                } else {
                    console.log(`      ✅ [موجود] ${episode.title.substring(0, 40)}...`);
                }
            }
            
            // نضيف المسلسل للمجموعة المعالجة
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

    // حفظ أحدث 10 حلقات في Home.json (مجلد eclips)
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

    // حفظ المسلسلات في Home.json (مجلد series)
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

    // حفظ جميع الحلقات في ملفات pageN.json
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
        console.log('🎬 مستخرج مسلسلات وحلقات رمضان 2026 (نسخة محسنة)');
        if (this.isFirstScan) {
            console.log('📌 هذه هي المرة الأولى - سيتم استخراج كل الحلقات');
        } else {
            console.log('📌 تشغيل تحديث - سيتم استخراج الحلقات الجديدة فقط');
        }
        console.log('='.repeat(60));
        
        await this.loadAllEpisodes();
        await this.extractAllSeries();
        
        console.log('\n' + '='.repeat(60));
        console.log('🔄 جاري معالجة المسلسلات واستخراج الحلقات...');
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
