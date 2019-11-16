const Apify = require('apify');
const _ = require('underscore');
const safeEval = require('safe-eval');

const { log } = Apify.utils;
log.setLevel(log.LEVELS.WARNING);

function delay(time) {
    return new Promise(((resolve) => {
        setTimeout(resolve, time);
    }));
}

const isObject = val => typeof val === 'object' && val !== null && !Array.isArray(val);

let detailsEnqueued = 0;

Apify.events.on('migrating', async () => {
    await Apify.setValue('detailsEnqueued', detailsEnqueued);
});

Apify.main(async () => {
    const input = await Apify.getInput();
    console.log('Input:');
    console.dir(input);

    if (!input || !Array.isArray(input.startUrls) || input.startUrls.length === 0) {
        throw new Error("Invalid input, it needs to contain at least one url in 'startUrls'.");
    }

    let extendOutputFunction;
    if (typeof input.extendOutputFunction === 'string' && input.extendOutputFunction.trim() !== '') {
        try {
            extendOutputFunction = safeEval(input.extendOutputFunction);
        } catch (e) {
            throw new Error(`'extendOutputFunction' is not valid Javascript! Error: ${e}`);
        }
        if (typeof extendOutputFunction !== 'function') {
            throw new Error('extendOutputFunction is not a function! Please fix it or use just default ouput!');
        }
    }

    const requestQueue = await Apify.openRequestQueue();

    detailsEnqueued = await Apify.getValue('detailsEnqueued');
    if (!detailsEnqueued) {
        detailsEnqueued = 0;
    }

    function checkLimit() {
        return input.maxItems && detailsEnqueued >= input.maxItems;
    }

    for (const item of input.startUrls) {
        const startUrl = item.url;

        if (checkLimit()) {
            break;
        }

        if (startUrl.includes('https://www2.hm.com/')) {
            if (startUrl.includes('productpage')) {
                await requestQueue.addRequest({ url: startUrl, userData: { label: 'item' } });
                detailsEnqueued++;
            } else {
                await requestQueue.addRequest({ url: startUrl, userData: { label: 'start' } });
            }
        }
    }

    const crawler = new Apify.CheerioCrawler({
        requestQueue,

        minConcurrency: 2,
        maxConcurrency: 5,
        maxRequestRetries: 1,
        handlePageTimeoutSecs: 60,

        handlePageFunction: async ({ request, body, $ }) => {
            await delay(1000);
            console.log(`Processing ${request.url}...`);

            if (request.userData.label === 'start') {
                const total = $('.filter-pagination').text().split(' ')[0].trim();
                const link = request.url + '?offset=0&page-size=' + total;

                await requestQueue.addRequest({ url: link, userData: { label: 'list' } });
            } else if (request.userData.label === 'list') {
                const itemLinks = $('.item-link');
                if (itemLinks.length === 0) {
                    return;
                }
                
                for (let index = 0; index < itemLinks.length; index++) {
                    if (checkLimit()) {
                        break;
                    }

                    const itemUrl = 'https://www2.hm.com' + $(itemLinks[index]).attr('href');
                    if (itemUrl) {
                        await requestQueue.addRequest({ url: `${itemUrl}`, userData: { label: 'item' } });
                        detailsEnqueued++;
                    }
                }
            } else if (request.userData.label === 'item') {
                // Extract javascript from body
                const javascriptStr = body.match(/\bproductArticleDetails\b\s=\s\{.*?\};/s)[0].replace('productArticleDetails =', '').trim().slice(0, -1);
                const json = safeEval(javascriptStr, { isDesktop: true });
                const name = $('.product-item-headline').text().trim();
                const itemId = request.url.match(/(\d*).html/)[1];
                let color = '';
                let variantId = '';
                $('.product-colors .list-item a').each((i,a) => {
                    if (i === 0) {
                        const $a = $(a);
                        color = $a.attr('title');
                        variantId = $a.attr('data-articlecode');
                    }
                });

                const variantObj = json[`${variantId}`];
                const sizes = variantObj.sizes.map(s => s.name).filter(s => s !== '');
                const price = $('.price-value').text().trim();

                const pageResult = {
                    url: request.url,
                    name,
                    itemId,
                    color,
                    sizes,
                    price,
                    '#debug': Apify.utils.createRequestDebugInfo(request),
                };

                if (extendOutputFunction) {
                    const userResult = await extendOutputFunction($);

                    if (!isObject(userResult)) {
                        console.log('extendOutputFunction has to return an object!!!');
                        process.exit(1);
                    }

                    _.extend(pageResult, userResult);
                }

                await Apify.pushData(pageResult);
            }
        },

        // This function is called if the page processing failed more than maxRequestRetries+1 times.
        handleFailedRequestFunction: async ({ request }) => {
            console.log(`Request ${request.url} failed twice.`);
        },

        ...input.proxyConfiguration,
    });

    // Run the crawler and wait for it to finish.
    await crawler.run();

    console.log('Crawler finished.');
});
