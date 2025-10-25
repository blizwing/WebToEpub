/*
  Base class that all parsers build from.
*/
"use strict";

/**
 * For sites that have multiple chapters per web page, this can minimize HTTP calls
 */
class FetchCache { // eslint-disable-line no-unused-vars
    constructor() {
        this.path = null;
        this.dom = null;
    }

    async fetch(url) {
        if  (!this.inCache(url)) {
            this.dom = (await HttpClient.wrapFetch(url)).responseXML;
            this.path = new URL(url).pathname;
        }
        return this.dom.cloneNode(true);
    }

    inCache(url) {
        return (((new URL(url).pathname) === this.path) 
        && (this.dom !== null));
    }
}

/**
 * A Parser's state variables
*/
class ParserState {
    constructor() {
        this.webPages = new Map();
        this.chapterListUrl = null;
    }

    setPagesToFetch(urls) {
        let nextPrevChapters = new Set();
        this.webPages = new Map();
        for (let i = 0; i < urls.length; ++i) {
            let page = urls[i];
            if (i < urls.length - 1) {
                nextPrevChapters.add(util.normalizeUrlForCompare(urls[i + 1].sourceUrl));
            }
            page.nextPrevChapters = nextPrevChapters;
            this.webPages.set(page.sourceUrl, page);
            nextPrevChapters = new Set();
            nextPrevChapters.add(util.normalizeUrlForCompare(page.sourceUrl));
        }
    }
}

class Parser {
    constructor(imageCollector) {
        // Rate limiting configuration
        // Override these in parser subclasses for site-specific requirements
        this.minimumThrottle = 500; // Minimum delay between starting chapter downloads (in ms)
        this.maxSimultanousFetchSize = 1; // Legacy: kept for backward compatibility
        this.maxConcurrentDownloads = 3; // Default max concurrent chapter downloads (can be overridden per parser)

        this.state = new ParserState();
        this.imageCollector = imageCollector || new ImageCollector();
        this.userPreferences = null;
        this.rateLimiter = null; // Will be initialized when user preferences are set
    }

    copyState(otherParser) {
        this.state = otherParser.state;
        this.imageCollector.copyState(otherParser.imageCollector);
        this.userPreferences = otherParser.userPreferences;
    }

    setPagesToFetch(urls) {
        this.state.setPagesToFetch(urls);
    }

    getPagesToFetch() {
        return this.state.webPages;
    }
    
    //Use this option if the parser isn't sending the correct HTTP header
    isCustomError(response) {  // eslint-disable-line no-unused-vars
        return false;
    }

    setCustomErrorResponse(url, wrapOptions, checkedresponse) {
        //example
        let ret = {};
        ret.url = url;
        ret.wrapOptions = wrapOptions;
        ret.response = {};
        //URL that's get opened on 'Open URL for Captcha' click
        ret.response.url = checkedresponse.response.url;
        ret.response.status = 403;
        //How often should it be retried and with how much delay in between
        ret.response.retryDelay = [80,40,20,10,5];
        ret.errorMessage = "This is a custom error message that will be displayed should all retries fail";
        //return empty to throw error
        return {};
    }

    onUserPreferencesUpdate(userPreferences) {
        this.userPreferences = userPreferences;
        this.imageCollector.onUserPreferencesUpdate(userPreferences);
        this.initializeRateLimiter();
    }

    initializeRateLimiter() {
        if (!this.userPreferences) {
            return;
        }

        // Get max concurrent downloads from user preferences or use parser default
        let maxConcurrent = this.maxConcurrentDownloads;
        if (this.userPreferences.maxConcurrentDownloads?.value) {
            let userValue = parseInt(this.userPreferences.maxConcurrentDownloads.value);
            if (!isNaN(userValue) && userValue > 0) {
                maxConcurrent = userValue;
            }
        }

        // Get rate limit delay
        let rateLimit = this.getRateLimit();

        // Create or update rate limiter
        if (this.rateLimiter) {
            this.rateLimiter.setMaxConcurrent(maxConcurrent);
            this.rateLimiter.setMinDelayBetweenStarts(rateLimit);
        } else {
            this.rateLimiter = new RateLimiter(maxConcurrent, rateLimit);
        }
    }

    isWebPagePackable(webPage) {
        return ((webPage.isIncludeable)
         && ((webPage.rawDom != null) || (webPage.error != null)));
    }

    convertRawDomToContent(webPage) {
        let content = this.findContent(webPage.rawDom);
        this.customRawDomToContentStep(webPage, content);
        util.decodeCloudflareProtectedEmails(content);
        if (this.userPreferences.removeNextAndPreviousChapterHyperlinks.value) {
            this.removeNextAndPreviousChapterHyperlinks(webPage, content);
        }
        this.removeUnwantedElementsFromContentElement(content);
        this.addTitleToContent(webPage, content);
        util.fixBlockTagsNestedInInlineTags(content);
        this.imageCollector.replaceImageTags(content);
        util.removeUnusedHeadingLevels(content);
        util.makeHyperlinksRelative(webPage.rawDom.baseURI, content);
        util.setStyleToDefault(content);
        util.prepForConvertToXhtml(content);
        util.removeEmptyAttributes(content);
        util.removeSpansWithNoAttributes(content);
        util.removeEmptyDivElements(content);
        util.removeTrailingWhiteSpace(content);
        if (util.isElementWhiteSpace(content)) {
            let errorMsg = UIText.Warning.warningNoVisibleContent(webPage.sourceUrl);
            ErrorLog.showErrorMessage(errorMsg);
        }
        return content;
    }

    addTitleToContent(webPage, content) {
        let title = this.findChapterTitle(webPage.rawDom, webPage);
        if (title != null) {
            if (title instanceof HTMLElement) {
                title = title.textContent;
            }
            if (webPage.title == "[placeholder]") {
                webPage.title = title.trim();
            }
            if (!this.titleAlreadyPresent(title, content)) {
                let titleElement = webPage.rawDom.createElement("h1");
                titleElement.appendChild(webPage.rawDom.createTextNode(title.trim()));
                content.insertBefore(titleElement, content.firstChild);
            }
        } else {
            if (webPage.title == "[placeholder]") {
                webPage.title = webPage.rawDom.title;
            }
        }
    }

    titleAlreadyPresent(title, content) {
        let existingTitle = content.querySelector("h1, h2, h3, h4, h5, h6");
        return (existingTitle != null)
            && (title.trim() === existingTitle.textContent.trim());
    }

    /**
     * Element with title of an individual chapter
     * Override when chapter title not in content element
    */
    findChapterTitle(dom) {   // eslint-disable-line no-unused-vars
        return null;
    }

    removeUnwantedElementsFromContentElement(element) {
        util.removeScriptableElements(element);
        util.removeComments(element);
        util.removeElements(element.querySelectorAll("noscript, input"));
        util.removeUnwantedWordpressElements(element);
        util.removeMicrosoftWordCrapElements(element);
        util.removeShareLinkElements(element);
        util.removeLeadingWhiteSpace(element);
    }

    customRawDomToContentStep(chapter, content) { // eslint-disable-line no-unused-vars
        // override for any custom processing
    }

    populateUI(dom) {
        CoverImageUI.showCoverImageUrlInput(true);
        let coverUrl = this.findCoverImageUrl(dom);
        CoverImageUI.setCoverImageUrl(coverUrl);
        this.updateParserMinimumDelayInfo();
        this.populateUIImpl();
    }

    updateParserMinimumDelayInfo() {
        // Show the parser's minimum delay requirement in the UI
        let infoSpan = document.getElementById("parserMinimumDelayInfo");
        if (infoSpan) {
            if (this.minimumThrottle > 0) {
                infoSpan.textContent = `(Parser minimum: ${this.minimumThrottle}ms)`;
            } else {
                infoSpan.textContent = "";
            }
        }
    }

    populateUIImpl() {
        // default implementation is do nothing more
    }

    /**
     * Default implementation, take first image in content section
    */
    findCoverImageUrl(dom) {
        if (dom != null) {
            let content = this.findContent(dom);
            if (content != null) {
                let cover = content.querySelector("img");
                if (cover != null) {
                    return cover.src;
                }
            }
        }
        return null;
    }

    removeNextAndPreviousChapterHyperlinks(webPage, element) {
        let elementToRemove = (this.findParentNodeOfChapterLinkToRemoveAt != null) ?
            this.findParentNodeOfChapterLinkToRemoveAt.bind(this)
            : (element) => element;

        let chapterLinks = [...element.querySelectorAll("a")]
            .filter(link => webPage.nextPrevChapters.has(util.normalizeUrlForCompare(link.href)))
            .map(link => elementToRemove(link));
        util.removeElements(chapterLinks);
    }

    /**
    * default implementation turns each webPage into single epub item
    */
    webPageToEpubItems(webPage, epubItemIndex) {
        let content = this.convertRawDomToContent(webPage);
        let items = [];
        if (content != null) {
            items.push(new ChapterEpubItem(webPage, content, epubItemIndex));
        }
        return items;
    }

    makePlaceholderEpubItem(webPage, epubItemIndex) {
        let temp = Parser.makeEmptyDocForContent(webPage.sourceUrl);
        temp.content.textContent = UIText.Default.chapterPlaceholderMessage(webPage.sourceUrl, webPage.error);
        util.convertPreTagToPTags(temp.dom, temp.content);
        return [new ChapterEpubItem(webPage, temp.content, epubItemIndex)];
    }

    /**
    * default implementation
    */
    static extractTitleDefault(dom) {
        let title = dom.querySelector("meta[property='og:title']");
        return (title === null) ? dom.title : title.getAttribute("content");
    }

    extractTitleImpl(dom) {
        return Parser.extractTitleDefault(dom);
    }

    extractTitle(dom) {
        let title = this.extractTitleImpl(dom);
        if (title == null) {
            title = Parser.extractTitleDefault(dom);
        }
        if (title.textContent !== undefined) {
            title = title.textContent;
        }
        return title.trim();
    }

    /**
    * default implementation
    */
    extractAuthor(dom) {  // eslint-disable-line no-unused-vars
        return "<unknown>";
    }

    /**
    * default implementation, 
    * if not available, default to English
    */
    extractLanguage(dom) {
        // try jetpack tag
        let locale = dom.querySelector("meta[property='og:locale']");
        if (locale !== null) {
            return locale.getAttribute("content");
        }

        // try <html>'s lang attribute
        locale = dom.querySelector("html").getAttribute("lang");
        return (locale === null) ? "en" : locale;
    }

    /**
    * default implementation, 
    * if not available, return ''
    */
    extractSubject(dom) {   // eslint-disable-line no-unused-vars
        return "";
    }

    extractDescription(dom) {
        let infoDiv = document.createElement("div");
        if (this.getInformationEpubItemChildNodes !== undefined)
        {
            this.populateInfoDiv(infoDiv, dom);
        }
        return infoDiv.textContent;
    }

    /**
    * default implementation, Derived classes will override
    */
    extractSeriesInfo(dom, metaInfo) {  // eslint-disable-line no-unused-vars
    }

    async loadEpubMetaInfo(dom) {  // eslint-disable-line no-unused-vars
        return;
    }

    getEpubMetaInfo(dom, useFullTitle) {
        let metaInfo = new EpubMetaInfo();
        metaInfo.uuid = dom.baseURI;
        try {
            metaInfo.title = this.extractTitle(dom);
        }
        catch (err) {
            metaInfo.title = "";
        }
        try {
            metaInfo.author = this.extractAuthor(dom).trim();
        }
        catch (err) {
            metaInfo.author = "";
        }
        try {
            metaInfo.language = this.extractLanguage(dom);
        }
        catch (err) {
            metaInfo.language = "";
        }
        try {
            metaInfo.fileName = this.makeSaveAsFileNameWithoutExtension(metaInfo.title, useFullTitle);
        }
        catch (err) {
            metaInfo.fileName = "web.epub";
        }
        try {
            metaInfo.subject = this.extractSubject(dom);
        }
        catch (err) {
            metaInfo.subject = "";
        }
        try {
            metaInfo.description = this.extractDescription(dom);
        }
        catch (err) {
            metaInfo.description = "";
        }
        this.extractSeriesInfo(dom, metaInfo);
        return metaInfo;
    }

    singleChapterStory(baseUrl, dom) {
        return [{
            sourceUrl: baseUrl,
            title: this.extractTitle(dom)
        }];
    }

    getBaseUrl(dom) {
        return Array.from(dom.getElementsByTagName("base"))[0].href;
    }

    makeSaveAsFileNameWithoutExtension(title, useFullTitle) {
        let maxFileNameLength = useFullTitle ? 512 : 20;
        let fileName = (title == null)  ? "web" : util.safeForFileName(title, maxFileNameLength);
        if (util.isStringWhiteSpace(fileName)) {
            // title is probably not English, so just use it as is
            fileName = title;
        }
        return fileName;
    }

    epubItemSupplier() {
        let epubItems = this.webPagesToEpubItems([...this.state.webPages.values()]);
        this.fixupHyperlinksInEpubItems(epubItems);
        return new EpubItemSupplier(this, epubItems, this.imageCollector);
    }

    webPagesToEpubItems(webPages) {
        let epubItems = [];
        let index = 0;

        if (this.userPreferences.addInformationPage.value &&
            this.getInformationEpubItemChildNodes !== undefined) {
            epubItems.push(this.makeInformationEpubItem(this.state.firstPageDom));
            ++index;
        }

        for (let webPage of webPages.filter(c => this.isWebPagePackable(c))) {
            let newItems = (webPage.error == null)
                ? webPage.parser.webPageToEpubItems(webPage, index)
                : this.makePlaceholderEpubItem(webPage, index);
            epubItems = epubItems.concat(newItems);
            index += newItems.length;
            delete(webPage.rawDom);
        }
        return epubItems;
    }

    makeInformationEpubItem(dom) {
        let titleText = UIText.Default.informationPageTitle;
        let title = document.createElement("h1");
        title.appendChild(document.createTextNode(titleText));
        let div = document.createElement("div");
        let urlElement = document.createElement("p");
        let bold = document.createElement("b");
        bold.textContent = UIText.Default.tableOfContentsUrl;
        urlElement.appendChild(bold);
        urlElement.appendChild(document.createTextNode(this.state.chapterListUrl));
        div.appendChild(urlElement);
        let infoDiv = document.createElement("div");
        this.populateInfoDiv(infoDiv, dom);    
        let childNodes = [title, div, infoDiv];
        let chapter = {
            sourceUrl: this.state.chapterListUrl,
            title: titleText,
            newArch: null
        };
        return new ChapterEpubItem(chapter, {childNodes: childNodes}, 0);
    }

    populateInfoDiv(infoDiv, dom) {
        for (let n of this.getInformationEpubItemChildNodes(dom).filter(n => n != null)) {
            let clone = util.sanitizeNode(n);
            if (clone) {
                this.cleanInformationNode(clone);
            }
            if (clone != null) {
                infoDiv.appendChild(clone);
            }
        }
        // this "page" doesn't go through image collector, so strip images
        util.removeChildElementsMatchingSelector(infoDiv, "img");
    }

    cleanInformationNode(node) {     // eslint-disable-line no-unused-vars
        // do nothing, derived class overrides as required
    }

    // called when plugin has obtained the first web page
    async onLoadFirstPage(url, firstPageDom) {
        this.state.firstPageDom = firstPageDom;
        this.state.chapterListUrl = url;
        let chapterUrlsUI = new ChapterUrlsUI(this);
        this.userPreferences.setReadingListCheckbox(url);

        try {
            let chapters = await this.getChapterUrls(firstPageDom, chapterUrlsUI);
            if (this.userPreferences.chaptersPageInChapterList.value) {
                chapters = this.addFirstPageUrlToWebPages(url, firstPageDom, chapters);
            }
            chapters = this.cleanWebPageUrls(chapters);
            chapters?.forEach(chapter => chapter.title = chapter.title?.trim());
            await this.userPreferences.readingList.deselectOldChapters(url, chapters);
            chapterUrlsUI.populateChapterUrlsTable(chapters);
            if (0 < chapters.length) {
                if (chapters[0].sourceUrl === url) {
                    chapters[0].rawDom = firstPageDom;
                    this.updateLoadState(chapters[0]);
                }
                ProgressBar.setValue(0);
            }
            this.state.setPagesToFetch(chapters);
            chapterUrlsUI.connectButtonHandlers();
        } catch (err) {
            ErrorLog.showErrorMessage(err);
        }
    }

    cleanWebPageUrls(webPages) {
        let foundUrls = new Set();
        let isUnique = function(webPage) {
            let unique = !foundUrls.has(webPage.sourceUrl);
            if (unique) {
                foundUrls.add(webPage.sourceUrl);
            }
            return unique;
        };

        return webPages
            .map(this.fixupImgurGalleryUrl)
            .filter(p => util.isUrl(p.sourceUrl))
            .filter(isUnique);
    }

    fixupImgurGalleryUrl(webPage) {
        webPage.sourceUrl = Imgur.fixupImgurGalleryUrl(webPage.sourceUrl);
        return webPage;
    }

    addFirstPageUrlToWebPages(url, firstPageDom, webPages) {
        let present = webPages.find(e => e.sourceUrl === url);
        if (present)
        {
            return webPages;
        } else {
            return [{
                sourceUrl:  url,
                title: this.extractTitle(firstPageDom)
            }].concat(webPages);
        }
    }

    onFetchChaptersClicked() {
        if (0 == this.state.webPages.size) {
            ErrorLog.showErrorMessage(UIText.Error.noChaptersFoundAndFetchClicked);
        } else {
            this.fetchWebPages();
        }
    }

    fetchContent() {
        return this.fetchWebPages();
    }

    setUiToShowLoadingProgress(length) {
        main.getPackEpubButton().disabled = true;
        ProgressBar.setMax(length + 1);
        ProgressBar.setValue(1);
        ProgressBar.startTimer();
    }

    async fetchWebPages() {
        let pagesToFetch = [...this.state.webPages.values()].filter(c => c.isIncludeable);
        if (pagesToFetch.length === 0) {
            return Promise.reject(new Error("No chapters found."));
        }

        this.setUiToShowLoadingProgress(pagesToFetch.length);

        this.imageCollector.reset();
        this.imageCollector.setCoverImageUrl(CoverImageUI.getCoverImageUrl());

        await this.addParsersToPages(pagesToFetch);

        // Initialize rate limiter if not already done
        if (!this.rateLimiter) {
            this.initializeRateLimiter();
        }

        // MEMORY OPTIMIZATION: Process chapters in chunks to prevent memory buildup
        // This ensures we don't hold too many DOM objects in memory at once
        const CHUNK_SIZE = 10; // Process and clean up every 10 chapters
        let completedCount = 0;

        // Use rate limiter for parallel downloads with rate limiting
        let downloadPromises = pagesToFetch.map(webPage =>
            this.rateLimiter.execute(async () => {
                if (util.sleepController.signal.aborted) {
                    return;
                }
                await this.fetchWebPageContent(webPage);

                completedCount++;

                // Every CHUNK_SIZE chapters, yield to event loop for cleanup
                if (completedCount % CHUNK_SIZE === 0) {
                    // Give browser time to process events and run garbage collection
                    await util.sleep(100);
                }
            })
        );

        // Wait for ALL chapters to complete downloading before proceeding to pack EPUB
        await Promise.all(downloadPromises);

        // Final yield before packing to ensure UI is responsive
        await util.sleep(50);
    }

    async addParsersToPages(pagesToFetch) {
        parserFactory.addParsersToPages(this, pagesToFetch);
    }

    groupPagesToFetch(webPages, index) {
        return webPages.slice(index, index + this.maxSimultanousFetchSize);
    }

    async fetchWebPageContent(webPage) {
        ChapterUrlsUI.showDownloadState(webPage.row, ChapterUrlsUI.DOWNLOAD_STATE_DOWNLOADING);
        let pageParser = webPage.parser;

        // Retry configuration: up to 3 retries with 3-5 second delays
        const maxRetries = 3;
        let lastError = null;

        for (let retryAttempt = 0; retryAttempt <= maxRetries; retryAttempt++) {
            try {
                let webPageDom = await pageParser.fetchChapter(webPage.sourceUrl);
                delete webPage.error;
                webPage.rawDom = webPageDom;
                pageParser.preprocessRawDom(webPageDom);
                pageParser.removeUnusedElementsToReduceMemoryConsumption(webPageDom);
                let content = pageParser.findContent(webPage.rawDom);
                if (content == null) {
                    let errorMsg = UIText.Error.errorContentNotFound(webPage.sourceUrl);
                    throw new Error(errorMsg);
                }
                // Fetch images and update progress
                await pageParser.fetchImagesUsedInDocument(content, webPage);

                // Mark chapter as complete in UI (updates happen as soon as each chapter finishes)
                ChapterUrlsUI.showDownloadState(webPage.row, ChapterUrlsUI.DOWNLOAD_STATE_LOADED);
                ProgressBar.updateValue(1);

                // MEMORY OPTIMIZATION: Yield to browser event loop to prevent freezing
                // This allows the browser to update UI and run garbage collection
                await util.sleep(0);

                return; // Success - exit retry loop
            } catch (error) {
                lastError = error;

                // If this wasn't the last retry attempt, wait and try again
                if (retryAttempt < maxRetries) {
                    // Wait 3-5 seconds before retrying
                    const delayMs = 3000 + Math.random() * 2000;
                    console.log(`Chapter download failed: ${webPage.sourceUrl}. Retrying in ${(delayMs / 1000).toFixed(1)}s (attempt ${retryAttempt + 1}/${maxRetries})`);
                    await util.sleep(delayMs);
                    continue; // Try again
                }

                // All retries exhausted - handle error
                if (this.userPreferences.skipChaptersThatFailFetch.value) {
                    ErrorLog.log(lastError);
                    webPage.error = lastError;
                    ChapterUrlsUI.showDownloadState(webPage.row, ChapterUrlsUI.DOWNLOAD_STATE_LOADED);
                    ProgressBar.updateValue(1); // Update progress bar even for failed chapters
                } else {
                    webPage.isIncludeable = false;
                    throw lastError;
                }
            }
        }
    }

    async fetchImagesUsedInDocument(content, webPage) {
        let revisedContent = await this.imageCollector.preprocessImageTags(content, webPage.sourceUrl);
        this.imageCollector.findImagesUsedInDocument(revisedContent);
        await this.imageCollector.fetchImages(() => { }, webPage.sourceUrl);
        // Progress update moved to fetchWebPageContent for better real-time feedback
    }

    /**
    * default implementation
    * derived classes override if need to do something to fetched DOM before
    * normal processing steps
    */
    preprocessRawDom(webPageDom) { // eslint-disable-line no-unused-vars
    }

    removeUnusedElementsToReduceMemoryConsumption(webPageDom) {
        // MEMORY OPTIMIZATION: Remove more unused elements to reduce DOM size
        // Remove interactive elements, scripts, styles, and other heavy elements
        util.removeElements(webPageDom.querySelectorAll(
            "select, iframe, video, audio, object, embed, " +
            "script, style, link[rel='stylesheet'], " +
            "nav, header, footer, aside, " +
            ".sidebar, .navigation, .menu, .advertisement, .ads, " +
            "[data-ad], [class*='ad-'], [id*='ad-']"
        ));

        // Remove inline styles to reduce memory footprint
        let elementsWithStyle = webPageDom.querySelectorAll("[style]");
        for (let elem of elementsWithStyle) {
            // Keep only essential layout styles, remove everything else
            elem.removeAttribute("style");
        }
    }

    // Hook if need to chase hyperlinks in page to get all chapter content
    async fetchChapter(url) {
        return (await HttpClient.wrapFetch(url)).responseXML;
    }

    updateReadingList() {
        this.userPreferences.readingList.update(
            this.state.chapterListUrl,
            [...this.state.webPages.values()]
        );
    }

    updateLoadState(webPage) {
        ChapterUrlsUI.showDownloadState(webPage.row, ChapterUrlsUI.DOWNLOAD_STATE_LOADED);
        ProgressBar.updateValue(1);
    }

    // Hook point, when need to do something when "Pack EPUB" pressed
    onStartCollecting() {
    }    

    fixupHyperlinksInEpubItems(epubItems) {
        let targets = this.sourceUrlToEpubItemUrl(epubItems);
        for (let item of epubItems) {
            for (let link of item.getHyperlinks().filter(this.isUnresolvedHyperlink)) {
                if (!this.hyperlinkToEpubItemUrl(link, targets)) {
                    this.makeHyperlinkAbsolute(link);
                }
            }
        }
    }

    sourceUrlToEpubItemUrl(epubItems) {
        let targets = new Map();
        for (let item of epubItems) {
            let key = util.normalizeUrlForCompare(item.sourceUrl);
            
            // Some source URLs may generate multiple epub items.
            // In that case, want FIRST epub item
            if (!targets.has(key)) {
                targets.set(key, util.makeRelative(item.getZipHref()));
            }
        }
        return targets;
    }

    isUnresolvedHyperlink(link) {
        let href = link.getAttribute("href");
        if (href == null) {
            return false;
        }
        return !href.startsWith("#") &&
            !href.startsWith("../Text/");
    }

    hyperlinkToEpubItemUrl(link, targets) {
        let key = util.normalizeUrlForCompare(link.href);
        let targetInEpub = targets.has(key);
        if (targetInEpub) {
            link.href = targets.get(key) + link.hash;
        }
        return targetInEpub;
    }

    makeHyperlinkAbsolute(link) {
        if (link.href !== link.getAttribute("href")) {
            link.href = link.href;       // eslint-disable-line no-self-assign
        }
    }

    disabled() {
        return null;
    }

    tagAuthorNotes(elements) {
        for (let e of elements) {
            e.classList.add("webToEpub-author-note");
        }
    }

    tagAuthorNotesBySelector(element, selector) {
        let notes = element.querySelectorAll(selector);
        if (this.userPreferences.removeAuthorNotes.value) {
            util.removeElements(notes);
        } else {
            this.tagAuthorNotes(notes);
        }
    }

    static makeEmptyDocForContent(baseUrl) {
        let dom = document.implementation.createHTMLDocument("");
        if (baseUrl != null) {
            util.setBaseTag(baseUrl, dom);        
        }
        let content = dom.createElement("div");
        content.className = Parser.WEB_TO_EPUB_CLASS_NAME;
        dom.body.appendChild(content);
        return {
            dom: dom,
            content: content 
        };
    }

    static findConstrutedContent(dom) {
        return dom.querySelector("div." + Parser.WEB_TO_EPUB_CLASS_NAME);
    }

    async getChapterUrlsFromMultipleTocPages(dom, extractPartialChapterList, getUrlsOfTocPages, chapterUrlsUI)  {
        let chapters = extractPartialChapterList(dom);
        let urlsOfTocPages = getUrlsOfTocPages(dom);
        return await this.getChaptersFromAllTocPages(chapters, extractPartialChapterList, urlsOfTocPages, chapterUrlsUI);
    }

    getRateLimit()
    {
        // Get the manual delay from user preferences
        let manualDelayPerChapterValue = parseInt(this.userPreferences.manualDelayPerChapter.value);

        // If manual delay is set and valid, use it; otherwise use parser's minimum throttle
        if (!isNaN(manualDelayPerChapterValue) && manualDelayPerChapterValue > 0) {
            // Use the higher of manual delay or parser's minimum (to respect site requirements)
            return Math.max(this.minimumThrottle, manualDelayPerChapterValue);
        }

        // Default to parser's minimum throttle
        return this.minimumThrottle;
    }

    async rateLimitDelay() {
        let manualDelayPerChapterValue = this.getRateLimit();
        await util.sleep(manualDelayPerChapterValue);
    }

    async getChaptersFromAllTocPages(chapters, extractPartialChapterList, urlsOfTocPages, chapterUrlsUI, wrapOptions)  {
        if (0 < chapters.length) {
            chapterUrlsUI.showTocProgress(chapters);
        }
        for (let url of urlsOfTocPages) {
            await this.rateLimitDelay();
            let newDom = (await HttpClient.wrapFetch(url, wrapOptions)).responseXML;
            let partialList = extractPartialChapterList(newDom);
            chapterUrlsUI.showTocProgress(partialList);
            chapters = chapters.concat(partialList);
        }
        return chapters;
    }

    async walkTocPages(dom, chaptersFromDom, nextTocPageUrl, chapterUrlsUI) {
        let chapters = chaptersFromDom(dom);
        chapterUrlsUI.showTocProgress(chapters);
        let url = nextTocPageUrl(dom, chapters, chapters);
        while (url != null) {
            await this.rateLimitDelay();
            dom = (await HttpClient.wrapFetch(url)).responseXML;
            let partialList = chaptersFromDom(dom);
            chapterUrlsUI.showTocProgress(partialList);
            chapters = chapters.concat(partialList);
            url = nextTocPageUrl(dom, chapters, partialList);
        }
        return chapters;
    }

    moveFootnotes(dom, content, footnotes) {
        if (0 < footnotes.length) {
            let list = dom.createElement("ol");
            for (let f of footnotes) {
                let item = dom.createElement("li");
                f.removeAttribute("style");
                item.appendChild(f);
                list.appendChild(item);
            }
            let header = dom.createElement("h2");
            header.appendChild(dom.createTextNode("Footnotes"));
            content.appendChild(header);
            content.appendChild(list);
        }
    }

    async walkPagesOfChapter(url, moreChapterTextUrl) {
        let dom = (await HttpClient.wrapFetch(url)).responseXML;
        let count = 2;
        let nextUrl = moreChapterTextUrl(dom, url, count);
        let oldContent = this.findContent(dom);
        while (nextUrl != null) {
            await this.rateLimitDelay();
            let nextDom = (await HttpClient.wrapFetch(nextUrl)).responseXML;
            let newContent = this.findContent(nextDom);
            nextUrl = moreChapterTextUrl(nextDom, url, ++count);
            oldContent.appendChild(dom.createElement("br"));
            util.moveChildElements(newContent, oldContent);
        }
        return dom;
    }    
}

Parser.WEB_TO_EPUB_CLASS_NAME = "webToEpubContent";
