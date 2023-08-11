const { app, BrowserWindow, ipcMain, dialog, Notification, shell } = require("electron");
const path = require("path");
const puppeteer = require("puppeteer");
const chromium = require("chromium");
const { Observable } = require("object-observer");
const Options = require("../options.json");
const package = require('../package.json')
const {
    generateId,
    getFolderContents,
    setPropertyByPath,
    deleteFolder,
    createFolder,
    writeFile,
    readFile,
    getTimeZone,
    shuffleArray,
    checkProxyType,
    padZero,
} = require("./utils.js");
const ProxyChain = require("proxy-chain");
const fs = require("fs");
const { axiosClient: axios } = require("./utils.js");
const proxy_check = require("proxy-check");

////

axios.defaults.headers["x-access-token"] = readFile(
    path.join(app.getPath("userData"), "auth.txt")
);

axios.defaults.headers["app-version"] = package.version;

axios.interceptors.response.use(
    (res) => {
        const token = res.headers["x-access-token"];
        console.log(token);

        axios.defaults.headers["x-access-token"] = token;
        writeFile(path.join(app.getPath("userData"), "auth.txt"), token);

        return res;
    },
    (err) => {
        if (err.response.status) {
            console.log("ERROR CODE: " + err.response.status);
            switch (err.response.status) {
                case 426:
                    {
                        dialog.showMessageBox(mainWindow, {
                            type: "error",
                            title: "Устаревшая версия",
                            message: "Установите последнюю версию программы",
                            buttons: ["OK"]
                        }).then(() => {
                            app.quit();
                        });

                        break;
                    }
            }
        }

        throw err;
    }
);

if (require("electron-squirrel-startup")) {
    app.quit();
}

// const lockFilePath = path.join(app.getPath('temp'), 'myapp.lock');

// if (fs.existsSync(lockFilePath)) {
//     app.quit();
//     return;
// } else {
//     fs.writeFileSync(lockFilePath, '');

//     app.on('will-quit', () => {
//         fs.unlinkSync(lockFilePath);
//     });
// }

const logs = {};

const getBoostInfo = async() => {
    console.log("GETTING BOOST INFO");

    const res = await axios.post(
        Options.variables.SERVER_BASE_URL + "api/public/getBoostInfo", {}
    );

    // res.data.data.info.currentBoost.startsIn = -1000;
    // res.data.data.info.currentBoost.endsIn = 10000;
    // res.data.data.info.nextBoost.startsIn = 11000;

    return {
        info: res.data.data,
        ts: new Date().toJSON(),
    };
};

let mainWindow = null;

const getUsers = async(init = false) => {
    const users = getFolderContents(
        path.join(app.getPath("userData"), "./users")
    );

    if (!users) {
        fs.mkdirSync(path.join(app.getPath("userData"), "./users"));
        return {};
    }

    return await users.reduce(async(pv, cv) => {
        const cvid = parseInt(cv.name.split("_")[1]);
        const profileState = await JSON.parse(
            readFile(
                path.join(
                    app.getPath("userData"),
                    "./users/user_" + cvid + "/profileState.json"
                )
            )
        );
        const obj = {
            id: cvid,
            profileState: init ? {
                ...profileState,
                status: "default",
                busy: "none",
            } : profileState,
        };
        return {...(await pv), [cvid]: obj };
    }, Promise.resolve({}));
};

const getConsole = (profileId) => ({
    ...console,
    error: (e) => {
        const date = new Date();
        const newLog = {
            type: "error",
            content: e.stack,
            time: `${padZero(date.getHours())}:${padZero(date.getMinutes())}:${padZero(date.getSeconds())}`
        }
        if (!logs[profileId]) logs[profileId] = [newLog];
        else logs[profileId].push(newLog);
        console.error(e);
    },
    log: (...args) => {
        const date = new Date();
        const newLog = {
            type: "log",
            content: args.join(', '),
            time: `${padZero(date.getHours())}:${padZero(date.getMinutes())}:${padZero(date.getSeconds())}`
        }
        if (!logs[profileId]) logs[profileId] = [newLog];
        else logs[profileId].push(newLog);
        console.log(...args);
    }
});

const state_obj = {
    status: "loading",
    users_state: {
        status: "default",
        users: {},
    },
    boostInfo: null,
    appOptions: Options.app,
    timezoneOffset: new Date().getTimezoneOffset(),
    appInfo: {
        version: package.version
    }
};

const state = Observable.from(state_obj);

Observable.observe(state, async(changes) => {
    try {
        if (changes[0].path.length === 1) {
            state_obj[changes[0].path[0]] = await JSON.parse(
                JSON.stringify(changes[0].value)
            );
        } else {
            // let field = changes[0].path.reduce((pv, cv, i, arr) => {
            //     const res = i <= 1 ? state_obj[pv] : pv[cv];
            //     return res;
            // });
            // field[changes[0].path[changes[0].path.length - 1]]

            try {
                setPropertyByPath(
                    changes[0].path,
                    state_obj,
                    JSON.parse(JSON.stringify(changes[0].value))
                );
            } catch (e) {
                console.error(e);
                console.log(changes[0].path);
            }
        }
        mainWindow &&
            mainWindow.webContents.send("stateUpdate", { state: state_obj });
    } catch (error) {
        console.error(error);
    }
});

const flows_state_obj = {
    status: "default",
    flows: {},
};
const flows_state = Observable.from(flows_state_obj);
const flows = {};

Observable.observe(flows_state, async(changes) => {
    try {
        if (changes[0].path.length === 1) {
            flows_state_obj[changes[0].path[0]] = changes[0].value;
        } else {
            setPropertyByPath(
                changes[0].path,
                flows_state_obj,
                await JSON.parse(JSON.stringify(changes[0].value))
            );
        }
        mainWindow &&
            mainWindow.webContents.send("flowsStateUpdate", {
                state: flows_state_obj,
            });
    } catch (error) {
        console.error(error);
    }
});

const updateUserState = (id) => {
    const state = state_obj.users_state.users[id].profileState;
    state &&
        writeFile(
            path.join(
                app.getPath("userData"),
                `./users/user_${id}/profileState.json`
            ),
            JSON.stringify(state, null, 2)
        );
};

const updateBoostInfo = async() => {
    try {
        state.status = "loading";

        const res = await getBoostInfo();

        state.boostInfo = res;

        console.log(res.info.info);

        if (res.info.info.currentBoost.startsIn > 0) {
            setTimeout(updateBoostInfo, (res.info.info.currentBoost.startsIn - 20) * 1000);
        } else if (res.info.info.currentBoost.endsIn > 0) {
            setTimeout(updateBoostInfo, (res.info.info.currentBoost.endsIn - 20) * 1000);
        } else {
            setTimeout(updateBoostInfo, (res.info.info.nextBoost.startsIn - 20) * 1000);
        }

        if (!res.info.info.currentBoost.complete) {
            setTimeout(() => {
                state.boostInfo.info.info.currentBoost.complete = true;
                Object.entries(flows).forEach(async([k, v]) => {
                    if (v.status === "init") {
                        flows[k].destroy = true;
                        return;
                    }
                    try {
                        state.users_state.users[k].profileState.status = "loading";
                        updateUserState(k);

                        await v.browser.close();
                        v.proxyServer && (await v.proxyServer.close(true));

                        state.users_state.users[k].profileState.status = "default";
                    } catch (error) {
                        console.error(error);

                        state.users_state.users[k].profileState.status = "error";
                    }
                    updateUserState(k);
                });
            }, res.info.info.currentBoost.endsIn * 1000);
        }

        Object.entries(state.users_state.users).forEach(([k, v]) => {
            if (v.profileState.boostId !== res.info.info.currentBoost.id) {
                state.users_state.users[k].profileState.boostId =
                    res.info.info.currentBoost.id;
                state.users_state.users[k].profileState.completedVideos = [];
                updateUserState(k);
            }
        });

        state.status = "default";
    } catch (error) {
        console.error(error);

        state.status = "default";

        mainWindow && mainWindow.webContents.send("goLogin", {});
    }
};

const initBrowserNpage = async(launchOptions = {}, browserArgs = [], auth = null, console) => {
    const browser = await puppeteer.launch({
        executablePath: chromium.path,
        headless: false, //Options.puppeteer.headless,
        args: [...Options.puppeteer.browserArgs, ...browserArgs],
        defaultViewport: {
            width: 1920,
            height: 1080,
        },
        slowMo: Options.puppeteer.slowMo,
        protocolTimeout: 400000,
        ignoreDefaultArgs: ['--enable-automation'],
        // devtools: true
        ...launchOptions,
    });

    // const browserWSEndpoint = browser.wsEndpoint();
    // browser.disconnect();

    const initPage = (await browser.pages())[0];

    auth && await initPage.authenticate(auth);

    auth && await initPage
        .goto("https://www.google.com/", { timeout: 9999999 })
        .catch(async(e) => {
            console.error(e);

            mainWindow.webContents.send("error", e);

            await browser.close();

            throw new Error("Bad connection")
        });

    // await initPage.goto("about:blank");

    // await initPage.close();

    // await new Promise(r => setTimeout(r, 100000));

    // const page = await browser.newPage();
    // auth && await page.authenticate(auth);

    // await initPage.close();

    // page.goto;
    await initPage.evaluateOnNewDocument(() => {
        const newProto = navigator.__proto__;
        delete newProto.webdriver;
        navigator.__proto__ = newProto;
    });
    // await initPage.setUserAgent(Options.puppeteer.userAgent);

    // page.goto("https://www.youtube.com/", {
    //     timeout: 9999999,
    // });

    return [browser, initPage];
};

async function startProxyServer(proxy, port) {
    return new Promise(async function(resolve, reject) {
        try {
            await proxy_check(proxy);
        } catch (error) {
            console.error(error);

            reject(new Error("Invalid proxy."));
        }
        proxy = ((proxy.startsWith("http://") || proxy.startsWith("https://")) ? "" : "http://") + proxy;

        ProxyChain.redactUrl;
        const server = new ProxyChain.Server({
            port,
            verbose: false,
            prepareRequestFunction: function(params) {
                var {
                    request,
                    username,
                    password,
                    hostname,
                    port,
                    isHttp,
                    connectionId,
                } = params;
                return {
                    requestAuthentication: false,
                    // http://username:password@proxy.example.com:3128
                    upstreamProxyUrl: proxy,
                };
            },
        });

        // Emitted when HTTP connection is closed
        server.on("connectionClosed", (params) => {
            // var { connectionId, stats } = params;
        });

        // Emitted when HTTP request fails
        server.on("requestFailed", (params) => {
            var { request, error } = params;
        });

        server.listen(() => {
            resolve(server);
        });
    });
}

const boost = async(profileId) => {
    const flow = flows[profileId];

    if (!flow) return;

    const console = getConsole(profileId);

    const { browser, page, proxyServer } = flow;

    /////////////////////////////

    const waitSelector = async(
        selector,
        timeout = 2000,
        visible = false,
        logErrors = true,
        options = {}
    ) => {
        try {
            const res = await page.waitForSelector(selector, {
                visible,
                timeout,
                polling: Options.puppeteer.polling,
                ...options,
            });
            return !!res;
        } catch (error) {
            logErrors && console.error(error);
            return null;
        }
    };

    const inputSearch = async(query) => {
        try {
            const isSearchInput = await waitSelector("input#search");

            if (!isSearchInput) return false;

            const inputValue = await page.$eval("input#search", (el) => el.value);
            await page.focus("input#search");

            // for (let i = 0; i < inputValue.length; i++) {
            //     await page.keyboard.press("Backspace");
            // }

            await page.keyboard.down('Shift');
            await page.keyboard.press('ArrowUp', { shift: true });
            await page.keyboard.up('Shift');
            await page.keyboard.press("Backspace");

            await page.type("input#search", query);
        } catch (error) {
            console.error(error);
            return false;
        }
        return true;
    };

    const addFilters = async(filters_obj = {}) => {
        const filters_indexes = {
            date: 0,
            type: 1,
            duration: 2,
            pecs: 3,
            order: 4,
        };

        console.log("Adding filters");

        const filters = Object.entries(filters_obj);

        const doFilters = async() => {
            for (const [key, value] of filters) {
                const filters_group_index = filters_indexes[key];

                for (let i = 0; i < value.length; i++) {
                    const isFilterMenu = await waitSelector("#filter-button button", 5000);
                    if (!isFilterMenu) {
                        return false;
                    }

                    try {
                        await page.click("#filter-button button")
                    } catch (error) {
                        console.error(error);
                        return false;
                    }

                    await waitSelector('tp-yt-paper-dialog:not([aria-hidden])', 3000, false);

                    const clickFilter = await page
                        .evaluate(
                            async(props) => {
                                try {
                                    const { filters_group_index, value, i } = props;

                                    function clickOnElementCenter(element) {
                                        const { left, top, width, height } =
                                        element.getBoundingClientRect();
                                        const x = left + width / 2;
                                        const y = top + height / 2;
                                        const event = new MouseEvent("click", {
                                            view: window,
                                            bubbles: true,
                                            cancelable: true,
                                            clientX: x,
                                            clientY: y,
                                        });
                                        element.dispatchEvent(event);
                                    }

                                    const filters_groups = document.querySelectorAll(
                                        "ytd-search-filter-group-renderer"
                                    );

                                    const filter_button = filters_groups[
                                        filters_group_index
                                    ].querySelectorAll("ytd-search-filter-renderer #endpoint")[
                                        value[i]
                                    ];

                                    clickOnElementCenter(filter_button);

                                    return true;
                                } catch (error) {
                                    console.error(error);
                                    return false;
                                }
                            }, { filters_group_index, value, i }
                        )
                        .then((res) => res)
                        .catch((e) => {
                            console.error(e);
                            return null;
                        });

                    if (!clickFilter) {
                        return false;
                    }

                    await page
                        .waitForFunction(
                            (props) => {
                                const { filters_group_index, value, i } = props;

                                const filters_groups = document.querySelectorAll(
                                    "ytd-search-filter-group-renderer"
                                );

                                const filter_button = filters_groups[
                                    filters_group_index
                                ].querySelectorAll("ytd-search-filter-renderer #endpoint")[
                                    value[i]
                                ];

                                return filter_button.ariaSelected === "true";
                            }, { polling: Options.puppeteer.polling, timeout: 1000 }, { filters_group_index, value, i }
                        )
                        .catch(() => {});
                }
            }
            return true;
        }

        const df = await doFilters();

        try {
            if (await waitSelector('tp-yt-paper-dialog:not([aria-hidden])', 500, true, false)) {
                await page.click("#filter-button button");
            }
        } catch (error) {
            console.error(error);
        }
        return df;
    };

    const scrollToBottom = async() => {
        await page.evaluate(() => {
            window.scrollTo({
                top: document.documentElement.scrollHeight,
                behavior: "instant",
            });
        });
    };

    const findVideo = async(videoId) => {
        let prevCount = 0;
        let sameCounts_count = 0;

        while (true) {
            try {
                const videoFound = await waitSelector(
                    `a[href*="${videoId}"]`,
                    500,
                    false,
                    false
                );
                if (!videoFound) {
                    throw new Error("Video not found");
                }
                // click && (await page.click(`a[href*="${videoId}"]`));
                return await page.$$(`a[href*="${videoId}"]`);
            } catch (e) {
                const count =
                    (await page
                        .evaluate(() => {
                            const node = document.querySelector(
                                "ytd-two-column-search-results-renderer #primary .ytd-section-list-renderer#contents"
                            );
                            return node && node.childElementCount;
                        })
                        .catch(console.error)) || 1000;

                await scrollToBottom(page);

                await page
                    .waitForFunction(
                        (selector, count) => {
                            const element = document.querySelector(selector);
                            console.log(element.childElementCount);
                            return element && element.childElementCount >= count;
                        }, { timeout: 1000, polling: Options.puppeteer.polling },
                        "ytd-two-column-search-results-renderer #primary .ytd-section-list-renderer#contents",
                        count + 1 // количество элементов, которое вы ожидаете
                    )
                    .catch(() => {});

                if (sameCounts_count > 4) {
                    return null;
                }

                if (prevCount === count) {
                    sameCounts_count++;
                } else {
                    sameCounts_count = 0;
                    prevCount = count;
                }
            }
        }
    };

    const scrollTo = async(element) => {
        try {
            if (typeof element === "string") {
                const elm = await page.$(element);

                await page.evaluate((el) => {
                    el.scrollIntoView();
                }, elm);
            } else {
                await page.evaluate((el) => {
                    el.scrollIntoView();
                }, element);
            }
        } catch (error) {
            console.error(error);
        }
    };

    const waitForVideoEnded = async() => {
        const viewingLengthFactor =
            Math.random() *
            (Options.viewingLengthRange[1] - Options.viewingLengthRange[0]) +
            Options.viewingLengthRange[0];

        console.log("FACTOR", viewingLengthFactor);

        await page
            .waitForFunction(
                (factor) => {
                    const video = document.querySelector("video");

                    console.log(video.currentTime, video.duration, video.ended);

                    if (!video || !video.currentTime || !video.duration) return false;

                    const adNode = document.querySelector(".video-ads.ytp-ad-module");
                    console.log(adNode);
                    return (
                        (video.currentTime >= video.duration * 0.9 * factor ||
                            video.ended) &&
                        !(adNode && adNode.childElementCount !== 0)
                    );
                }, {
                    timeout: 240000,
                    polling: Options.puppeteer.polling,
                },
                viewingLengthFactor
            )
            .catch(console.error);
        console.log(await page.evaluate(() => (window.location.href)).catch(() => null));
        console.log("VIDEO HAS ENDED");
    };

    const isVideoLoaded = async() => {
        const videoLoaded = await page
            .waitForFunction(
                () => {
                    try {
                        return (
                            document.querySelector(".html5-video-player video").readyState ===
                            4
                        );
                    } catch (error) {
                        return false;
                    }
                }, { polling: Options.puppeteer.polling, timeout: 20000 }
            )
            .then((res) => res)
            .catch((e) => {
                console.error(e);
                return false;
            });
        return videoLoaded;
    };

    const isLoggedIn = async() => {
        return await page.evaluate(() => {
            try {
                return window.ytcfg.d().LOGGED_IN;
            } catch (error) {
                return false;
            }
        });
    }

    const isAD = async() => {
        const adSelector = ".video-ads.ytp-ad-module";

        const isAd = await page
            .$eval(adSelector, (element) => {
                return !!(element && element.childElementCount !== 0);
            })
            .catch(() => {});
        return isAd;
    };

    const videoActions = async() => {
        const state = {
            canAct: true,
        };

        const doActions = async() => {
            const initialRandom = Math.random();
            const actionsState = Object.entries(Options.boost.actions).reduce(
                (prev, cur) => {
                    prev = {
                        ...prev,
                        [cur[0]]: {
                            hasDoneTimes: 0,
                            chance: initialRandom <= Options.boost.actions[cur[0]].chance,
                        },
                    };
                    return prev;
                }, {}
            );
            console.log(actionsState);

            const actionsFuncs = {
                like: async() => {
                    try {
                        await page.click(
                            "ytd-watch-metadata #segmented-like-button button"
                        );

                        actionsState.like.hasDoneTimes++;
                    } catch (error) {
                        console.error(error);
                    }
                },
                comment: async() => {
                    try {
                        const options = Options.boost.actions.comment;

                        const commentBlock = await waitSelector(
                            "ytd-comments-header-renderer.style-scope.ytd-item-section-renderer",
                            2000
                        );

                        if (!commentBlock) {
                            return;
                        }

                        await scrollTo(
                            "ytd-comments-header-renderer.style-scope.ytd-item-section-renderer"
                        );

                        await page.click("#placeholder-area");

                        await waitSelector("#contenteditable-root", 2000);

                        const commentIndex = Math.floor(
                            Math.random() * options.data.comments.length
                        );
                        const text = options.data.comments[commentIndex];

                        await page.type("#contenteditable-root", text);

                        await waitSelector(
                            ".style-scope.ytd-commentbox#submit-button",
                            2000
                        );

                        await page.click(".style-scope.ytd-commentbox#submit-button");

                        await scrollTo("video");

                        actionsState.comment.hasDoneTimes++;
                    } catch (error) {
                        console.error(error);
                    }
                },
            };
            const actions = async() => {
                try {
                    const acts = Object.entries(actionsFuncs);

                    for (let i = 0; i < acts.length; i++) {
                        const act = acts[i];
                        const actState = actionsState[act[0]];
                        const actOptions = Options.boost.actions[act[0]];

                        const videoCurrentTime = await page.evaluate(() => {
                            return document.querySelector('video').currentTime;
                        }).catch(() => 0);

                        if (
                            (!actState.chance) || (actOptions.oneTime && actState.hasDoneTimes > 0) || (actOptions.from > videoCurrentTime || actOptions.to < videoCurrentTime)
                        ) {
                            continue;
                        } else {
                            console.log(act[0]);
                            await act[1]();
                        }
                    }
                } catch (error) {
                    console.error(error);
                }
            };

            while (state.canAct) {
                await actions();
                await new Promise((r) => setTimeout(r, 1000));
            }
        };

        doActions();

        return {
            stop: () => (state.canAct = false),
        };
    };

    const watchVideo = async() => {
        const videoLoaded = await isVideoLoaded();

        if (!videoLoaded) return;

        await new Promise(r => setTimeout(r, 3000));

        await checkForPause();

        const actions = await videoActions();

        await waitForVideoEnded();

        actions.stop();
    };

    const checkForPause = async() => {
        const pauseMode = await page.evaluate(() => {
            try {
                return document.querySelector(".html5-video-player video").paused;
            } catch (error) {
                return false;
            }
        });
        await waitSelector(".html5-video-player.playing-mode");

        if (pauseMode) {
            await waitSelector("button.ytp-play-button", 5000);
            await page.click("button.ytp-play-button").catch((e) => {});
        }
    };

    const isCaptcha = () => {
        return page.url().includes("google.com/sorry")
    }

    /////////////////////////////

    await page
        .goto("https://www.youtube.com/", {
            waitUntil: "load",
            timeout: 60000,
        })
        .catch(() => {});

    const videos = shuffleArray(state_obj.boostInfo.info.videos.filter(
        (v) =>
        !state_obj.users_state.users[profileId].profileState.completedVideos.some(
            (cv) => cv.video_id === v.id
        )
    ));

    const loggedIn = await isLoggedIn();

    if (!loggedIn) {
        throw new Error("Not logged in");
    }

    for (let i = 0; i < videos.length; i++) {
        if (isCaptcha()) {
            state.users_state.users[profileId].profileState.captcha = true;
            updateUserState(profileId);
            throw new Error("YouTube Captcha")
        }

        const video = videos[i];

        const result = {
            video_id: video.id,
            completeReason: null,
            foundVideo: null,
        };

        const doBoost = async() => {
            console.log("DO BOOST");

            const isSearchInput = await waitSelector("input#search");
            const href = await page.evaluate(() => (window.location.href))

            if (!isSearchInput && href !== "https://www.youtube.com/") {
                await page
                    .goto("https://www.youtube.com/", {
                        waitUntil: "load",
                        timeout: 10000,
                    })
                    .catch(() => {});
                if (isCaptcha()) {
                    state.users_state.users[profileId].profileState.captcha = true;
                    updateUserState(profileId);
                    throw new Error("YouTube Captcha")
                }
            } else if (!isSearchInput && href === "https://www.youtube.com/") {
                throw new Error("Unexpected error while trying to find video")
            }

            const typed = await inputSearch(video.query);

            if (!typed) {
                result.completeReason = "error";
                throw new Error("Could not make search");
            }

            await page.keyboard.press("Enter");
            await page.keyboard.press("Enter");
            await page.keyboard.press("Enter");

            await waitSelector("ytd-video-renderer", 4000, true);

            video.filters && (await addFilters(video.filters));

            // await page.waitForTimeout(3000);

            const videoBtns = await findVideo(video.ytvideo_id);

            console.log("Video Bts", videoBtns);

            const gotoVideo = async() => {
                await page
                    .goto("https://www.youtube.com/watch?v=" + video.ytvideo_id, {
                        waitUntil: "load",
                        timeout: 10000,
                    })
                    .catch(() => {});
            }

            if (videoBtns && videoBtns.length > 0) {
                result.foundVideo = true;
                let ok = false;
                for (let i = 0; i < videoBtns.length; i++) {
                    const btn = videoBtns[i];
                    console.log(btn);
                    try {
                        await btn.click();
                        i = videoBtns.length;
                        ok = true;
                    } catch (error) {
                        console.error(error);
                    }
                }
                if (!ok) {
                    result.foundVideo = false;
                    await gotoVideo();
                }
            } else {
                result.foundVideo = false;
                await gotoVideo();
            }

            await watchVideo();

            result.completeReason = "complete";
        };

        // try {
        await doBoost();
        // } catch (error) {
        //     console.error(error);

        //     result.completeReason = "error";
        // }

        await new Promise((r) => setTimeout(r, 1000));

        try {
            if (await browser.isConnected()) {
                await axios.post(Options.variables.SERVER_BASE_URL + "api/public/addView", {
                    data: {
                        view: {
                            video_id: result.video_id,
                            reason: (result.completeReason || "complete") + "_" + browser.process().pid,
                            foundVideo: result.foundVideo || false,
                            proxy: state_obj.users_state.users[profileId].profileState.options.proxy || null
                        }
                    }
                });

                const completedVideos =
                    state_obj.users_state.users[profileId].profileState.completedVideos;
                state.users_state.users[profileId].profileState.completedVideos = [
                    ...completedVideos,
                    {
                        ...result,
                        reason: (result.completeReason || "complete") + "_" + browser.process().pid,
                        foundVideo: result.foundVideo || false,
                    },
                ];

                updateUserState(profileId);
            } else {
                return;
            }
        } catch (error) {
            console.error(error);

            throw new Error("Could not send view report");
        }
    }
};

const ipcMain_Routes = {
    turnOnProfiles: async(event, data) => {
        const { profilesIds } = data;

        for (let i = 0; i < profilesIds.length; i++) {
            const profileId = profilesIds[i];

            const console = getConsole(profileId);

            try {
                if (!state_obj.users_state.users[profileId] || flows[profileId]) continue;

                flows[profileId] = {
                    profileId,
                    status: "init",
                };

                state.users_state.users[profileId].profileState.status = "loading";
                state.users_state.users[profileId].profileState.busy = "boost";
                updateUserState(profileId);

                let proxy =
                    state_obj.users_state.users[profileId].profileState.options.proxy;
                // const port = Options.proxyStartPort + profileId;                

                try {
                    // proxy && await proxy_check(proxy);
                } catch (error) {
                    console.error(error);

                    throw new Error("Invalid proxy.");
                }

                // const proxyServer = proxy ? await startProxyServer(proxy, port) : null;

                const logPass = proxy ? proxy.split("@")[0].split(":") : null;
                const auth = logPass && { username: logPass[0], password: logPass[1] };
                const [browser, page] = await initBrowserNpage({
                        userDataDir: path.join(
                            app.getPath("userData"),
                            "users/user_" + profileId
                        ),
                        headless: false,
                    },
                    proxy ? [`--proxy-server=${proxy.split("@")[1]}`] : [],
                    // proxyServer ? [`--proxy-server=http://localhost:` + port] : []
                    auth,
                    console
                );

                if (flows[profileId].destroy) {
                    try {
                        state.users_state.users[profileId].profileState.status = "loading";
                        updateUserState(profileId);

                        proxyServer && (await proxyServer.close(true));
                        await browser.close();

                        delete flows[profileId];

                        state.users_state.users[profileId].profileState.status = "default";
                        state.users_state.users[profileId].profileState.busy = "none";
                    } catch (error) {
                        console.error(error);

                        state.users_state.users[profileId].profileState.status = "error";
                    }
                    updateUserState(profileId);

                    return;
                }

                flows[profileId] = {
                    browser,
                    page,
                    profileId,
                    // proxyServer,
                    status: "default",
                };

                browser.on("disconnected", async function(event) {
                    try {
                        // proxyServer && (await proxyServer.close(true).catch(console.error));
                        delete flows[profileId];
                    } catch (error) {
                        console.error(error);
                    }

                    state.users_state.users[profileId].profileState.busy = "none";
                    updateUserState(profileId);
                });

                boost(profileId)
                    .then(() => {})
                    .catch(async(e) => {
                        console.error(e);
                        await new Promise((r) =>
                            setTimeout(() => {
                                if (browser.isConnected()) {
                                    mainWindow.webContents.send("pushNotification", {
                                        type: "error",
                                        content: "(" +
                                            state.users_state.users[profileId].profileState.options
                                            .name +
                                            ") " +
                                            e.toString(),
                                    });

                                    const notification = new Notification({
                                        title: "One Tap",
                                        body: e.toString(),
                                        icon: __dirname + "/resources/images/oneTap_logo.png"
                                    });

                                    notification.show();
                                }
                                r();
                            }, 1000)
                        );
                    })
                    .then(async() => {
                        console.log("BOOST COMPLETED");

                        try {
                            await browser.close();
                            // proxyServer &&
                            //     (await proxyServer.close(true).catch(console.error));
                        } catch (error) {
                            console.error(error);
                        }

                        state.users_state.users[profileId].profileState.status = "default";
                        updateUserState(profileId);
                    });

                // flows_state.flows[id] = {
                //     status: "default",
                //     numberOfVideos: 10,
                //     completedVideosCount: 0,
                //     id,
                // };
                state.users_state.users[profileId].profileState.status = "default";
                updateUserState(profileId);
            } catch (error) {
                console.error(error);

                mainWindow.webContents.send("pushNotification", {
                    type: "error",
                    content: "(" +
                        state.users_state.users[profileId].profileState.options.name +
                        ") " +
                        error.toString(),
                });

                try {
                    if (flows[profileId]) {
                        await flows[profileId].browser.close();
                        flows[profileId].proxyServer &&
                            (await flows[profileId].proxyServer
                                .close(true)
                                .catch(console.error));
                    }
                    delete flows[profileId];
                } catch (error) {
                    console.error(error);
                }

                state.users_state.users[profileId].profileState.status = "error";
                state.users_state.users[profileId].profileState.busy = "none";
                updateUserState(profileId);
            }
        }
    },
    turnOffProfiles: async(event, data) => {
        const { profilesIds } = data;

        for (let i = 0; i < profilesIds.length; i++) {
            const profileId = profilesIds[i];

            const flow = flows[profileId];

            if (!state_obj.users_state.users[profileId] || !flow) continue;

            try {
                const { browser, proxyServer } = flow;

                state.users_state.users[profileId].profileState.status = "loading";
                updateUserState(profileId);

                await browser.close();

                delete flows[profileId];

                // proxyServer && (await proxyServer.close(true).catch(console.error));

                state.users_state.users[profileId].profileState.status = "default";
            } catch (error) {
                state.users_state.users[profileId].profileState.status = "error";

                console.error(error);
            }
            state.users_state.users[profileId].profileState.busy = "none";
            updateUserState(profileId);
        }
    },
    updateProfileBoost: async(event, data) => {
        const { type, profileId } = data;

        const flow = flows[profileId];
        // const flow_state = flows_state_obj.flows[flowId];

        if (
            flow &&
            state_obj.users_state.users[profileId] &&
            state.users_state.users[profileId].profileState.status === "loading"
        )
            return;

        switch (type) {
            // case "continue":
            //     {
            //         flows_state.flows[flowId].status = "loading";

            //         const [browser, page] = await initBrowserNpage();

            //         flow = {
            //             ...flows[flowId],
            //             browser,
            //             page,
            //         };

            //         flows_state.flows[flowId].status = "started";

            //         break;
            //     }
            // case "pause":
            //     {
            //         flows_state.flows[flowId].status = "loading";
            //         try {
            //             await flow.browser.close();
            //         } catch (error) {
            //             console.error(error);
            //         }

            //         flow = {
            //             ...flows[flowId],
            //             browser: null,
            //             page: null,
            //         };

            //         flows_state.flows[flowId].status = "paused";

            //         break;
            //     }
            case "stop":
                {
                    state.users_state.users[profileId].profileState.status = "loading";
                    updateUserState(profileId);

                    try {
                        await flow.browser.close();
                    } catch (error) {
                        console.error(error);
                    }
                    delete flow;
                    // delete flows_state.flows[flowId];

                    state.users_state.users[profileId].profileState.status = "default";
                    updateUserState(profileId);

                    break;
                }
        }
    },
    browserProfile: async(event, data = {}) => {
        const { profileId } = data;

        if (!state_obj.users_state.users[profileId]) return;

        const console = getConsole(profileId);

        state.users_state.users[profileId].profileState.status = "loading";
        state.users_state.status = "loading";
        state.users_state.users[profileId].profileState.busy = "settingProfile";
        updateUserState(profileId);

        try {
            const proxy =
                state.users_state.users[profileId].profileState.options.proxy;
            const port = Options.proxyStartPort + profileId;

            try {
                // proxy && await proxy_check(proxy);
            } catch (error) {
                console.error(error);

                throw new Error("Invalid proxy.");
            }

            // const proxyServer = proxy ? await startProxyServer(proxy, port) : null;

            const logPass = proxy ? proxy.split("@")[0].split(":") : null;

            const auth = logPass && { username: logPass[0], password: logPass[1] };

            const [browser, page] = await initBrowserNpage({
                    userDataDir: path.join(
                        app.getPath("userData"),
                        "users/user_" + profileId
                    ),
                    headless: false,
                },
                proxy ? [`--proxy-server=${proxy.split("@")[1]}`] : [],
                // proxyServer ? [`--proxy-server=http://localhost:` + port] : []
                auth,
                console
            );

            state.users_state.users[profileId].profileState.status = "default";
            state.users_state.status = "default";
            updateUserState(profileId);

            browser.on("disconnected", async function(event) {
                try {
                    // proxyServer && (await proxyServer.close(true).catch(console.error));
                    state.users_state.users[profileId].profileState.captcha = false;
                    updateUserState(profileId);
                } catch (error) {
                    console.error(error);
                }

                state.users_state.users[profileId].profileState.busy = "none";
                state.users_state.status = "default";
                updateUserState(profileId);
            });

            await page
                .goto("https://www.youtube.com/", { timeout: 9999999 })
                .catch(() => {});
        } catch (error) {
            console.error(error);

            mainWindow.webContents.send("pushNotification", {
                type: "error",
                content: "(" +
                    state.users_state.users[profileId].profileState.options.name +
                    ") " +
                    error.toString(),
            });

            state.users_state.users[profileId].profileState.status = "error";
            state.users_state.status = "default";
            state.users_state.users[profileId].profileState.busy = "none";
            updateUserState(profileId);
        }
    },
    getInitialData: async(event, data = {}) => {
        state.users_state.users = await getUsers(true);
        await updateBoostInfo();

        mainWindow.webContents.send("initialData", {
            state: state_obj,
            flows_state: flows_state_obj,
        });
    },
    deleteBrowserProfile: async(event, data = {}) => {
        const { profileId } = data;
        try {
            deleteFolder(
                path.join(app.getPath("userData"), "./users/user_" + profileId)
            );
            state.users_state.users = await getUsers();
        } catch (error) {
            console.error(error);
        }
    },
    auth: async(event, data = {}) => {
        console.log(data);

        writeFile(path.join(app.getPath("userData"), `auth.txt`), data.data.token);
        axios.defaults.headers["x-access-token"] = data.data.token;

        await new Promise(r => setTimeout(r, 1000));

        await updateBoostInfo();

        await new Promise(r => setTimeout(r, 1000));

        mainWindow.webContents.send("goMain", {});
    },
    saveLogs: async(event, data = {}) => {
        const { profileId } = data;

        if (!logs[profileId]) {
            mainWindow.webContents.send("pushNotification", {
                content: "Nothing to save",
                type: "warning"
            });
            return;
        }

        const text = logs[profileId].map((log, index) => `${index + 1} ${log.time} [${log.type}] : ${log.content}`).join('\n\n');

        dialog.showSaveDialog({
            title: 'Save Logs',
            defaultPath: path.join(__dirname, `profile_${profileId}_logs.txt`),
            filters: [{ name: 'Text Files', extensions: ['txt'] }]
        }).then(result => {
            if (!result.canceled) {
                const filePath = result.filePath;
                fs.writeFile(filePath, text, err => {
                    if (err) {
                        console.error('Error saving file:', err);

                        mainWindow.webContents.send("pushNotification", {
                            content: "Could not save logs",
                            type: "error"
                        });
                    } else {
                        console.log('File saved successfully:', filePath);

                        mainWindow.webContents.send("pushNotification", {
                            content: "Logs saved successfuly",
                            type: "success"
                        });
                    }
                });
            }
        }).catch(err => {
            console.error('Error in dialog:', err);
            mainWindow.webContents.send("pushNotification", {
                content: "Could not save logs",
                type: "error"
            });
        });
    }
};

const ipcMain_Handles = {
    createBrowserProfile: async(event, data = {}) => {
        const { name = null, proxy = null } = data.data;

        mainWindow.webContents.send("log", data.data);

        if (state_obj.users_state.users.length >= Options.app.maxUsers)
            return {
                ok: false,
                message: "Создано максимальное количество профилей.",
            };

        if (proxy) {
            const proxyValid = checkProxyType(proxy)
            try {
                if (proxyValid) {
                    // const proxyCheck = await proxy_check(proxy);
                    // console.log(proxyCheck);
                } else {
                    return {
                        ok: false,
                        message: "Неверный формат прокси.",
                    };
                }
            } catch (error) {
                console.error(error);

                mainWindow.webContents.send("error", error);

                return {
                    ok: false,
                    message: "Невалидные прокси.",
                };
            }
        }

        try {
            const usersArr = Object.entries(state_obj.users_state.users).map(
                ([k, v]) => v
            );
            const lastProfile = usersArr[usersArr.length - 1];
            const profileId = lastProfile ? lastProfile.id + 1 : 1;
            createFolder(
                path.join(app.getPath("userData"), "./users/user_" + profileId)
            );

            const profileState = {
                options: {
                    proxy,
                    name,
                },
                completedVideos: [],
                status: "default",
                busy: "none",
                boostId: state.boostInfo.info.info.currentBoost.id || null,
                captcha: false
            };

            writeFile(
                path.join(
                    app.getPath("userData"),
                    "./users/user_" + profileId + "/profileState.json"
                ),
                JSON.stringify(profileState, null, 2)
            );
            state.users_state.users = await getUsers();
        } catch (error) {
            console.error(error);

            return {
                ok: false,
                message: error.toString(),
            };
        }

        return {
            ok: true,
        };
    },
    updateProfileOptions: async(event, data = {}) => {
        const { profileId = 2 } = data;
        const { name, proxy } = data.data;

        mainWindow.webContents.send("log", data.data);

        if (proxy) {
            const proxyValid = checkProxyType(proxy)
            try {
                if (proxyValid) {
                    // const proxyCheck = await proxy_check(proxy);
                    // console.log(proxyCheck);
                } else {
                    return {
                        ok: false,
                        message: "Неверный формат прокси.",
                    };
                }
            } catch (error) {
                console.error(error);

                mainWindow.webContents.send("error", error);

                return {
                    ok: false,
                    message: "Невалидные прокси.",
                };
            }
        }

        if (!state_obj.users_state.users[profileId])
            return {
                ok: false,
                message: "Профиль не найден.",
            };

        try {
            const profileState = state_obj.users_state.users[profileId].profileState;

            const newProfileState = {
                ...profileState,
                options: {
                    ...profileState.options,
                    name,
                    proxy,
                },
            };

            writeFile(
                path.join(
                    app.getPath("userData"),
                    `./users/user_${profileId}/profileState.json`
                ),
                JSON.stringify(newProfileState, null, 2)
            );
            state.users_state.users = await getUsers();
        } catch (error) {
            console.error(error);

            return {
                ok: false,
                message: error.toString(),
            };
        }

        return {
            ok: true,
        };
    },
};

const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false
        },
        minWidth: 800,
        minHeight: 600,
        show: false,
        title: "One Tap",
        icon: path.join(__dirname, './resources/images', 'oneTap_logo.ico'),
        // frame: false
    });

    mainWindow.maximize();
    mainWindow.show();

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(__dirname, 'build/index.html'));

    // mainWindow.loadURL("http://localhost:3000");

    // mainWindow.webContents.openDevTools();

    Object.entries(ipcMain_Routes).forEach(([route, handler]) =>
        ipcMain.on(route, handler)
    );

    Object.entries(ipcMain_Handles).forEach(([route, handler]) =>
        ipcMain.handle(route, handler)
    );

    // shell.showItemInFolder(app.getPath("userData"));
};

app.on("ready", () => {
    createWindow();
    // dialog.showMessageBox(mainWindow, {
    //     message: app.getPath("userData").toString(),
    // });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});