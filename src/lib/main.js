"use strict";

var self = require("sdk/self");
var tabs = require("sdk/tabs");
var ffStorage = require("sdk/simple-storage");
var timers = require("sdk/timers");
var panelSdk = require("sdk/panel");
var options = require("sdk/simple-prefs");
var notifications = require("sdk/notifications");
var _ = require("sdk/l10n").get;
var pageWorker = require("page-worker");
var chrome = require("chrome");
var Cc = chrome.Cc;
var Ci = chrome.Ci;
var prefs = require("sdk/preferences/service");
var feedlyApi = require("./feedly.api");
var widgetSdk = require("toolbarwidget");
var userstyles = require("./userstyles");

var appGlobal = {
    feedlyApiClient: feedlyApi.getClient(),
    feedlyTab: null,
    filtersTab: null,
    icons: {
        default: "images/icon20.png",
        inactive: "images/icon20_inactive.png"
    },
    options: {
        _updateInterval: 10,
        _maxNumberOfFeeds: 20,
        _popupFontSize: 100,

        markReadOnClick: true,
        showDesktopNotifications: true,
        showFullFeedContent: false,
        openSiteOnIconClick: false,
        showCounter: true,
        playSound: false,
        oldestFeedsFirst: false,
        abilitySaveFeeds: false,
        useSecureConnection: true,
        resetCounterOnClick: false,
        closePopupOnNewsOpen: false,
        closePopupWhenNoFeeds: false,
        showCategories: false,
        isFiltersEnabled: false,
        filters: [],
        leftClick: 0,
        rightClick: 1,
        middleClick: 2,

        get maxNumberOfFeeds() {
            var minimumFeeds = 1;
            return this._maxNumberOfFeeds >= 1 ? this._maxNumberOfFeeds : minimumFeeds;
        },
        set maxNumberOfFeeds(value) {
            this._maxNumberOfFeeds = value;
        },

        get updateInterval() {
            var minimumInterval = 10;
            return this._updateInterval >= minimumInterval ? this._updateInterval : minimumInterval;
        },
        set updateInterval(value) {
            return this._updateInterval = value;
        },
        get popupFontSize() {
            var maxValue = 150;
            var minValue = 70;
            if (this._popupFontSize > maxValue ) {
                return maxValue;
            }
            if (this._popupFontSize < minValue){
                return minValue;
            }
            return this._popupFontSize;
        },
        set popupFontSize(value) {
            this._popupFontSize = value;
        }
    },
    clickActions: {
        get showPopup() {
            return 0;
        },
        get openSite() {
            return 1;
        },
        get update() {
            return 2;
        },
        get none() {
            return 3;
        }
    },
    get globalGroup(){
        return "user/" + ffStorage.storage.feedlyUserId + "/category/global.all";
    },
    get savedGroup(){
        return "user/" + ffStorage.storage.feedlyUserId + "/tag/global.saved";
    },
    get feedlyUrl(){
        return this.options.useSecureConnection ? "https://feedly.com" : "http://feedly.com"
    },
    get globalUncategorized(){
        return "user/" + ffStorage.storage.feedlyUserId + "/category/global.uncategorized";
    },
    subscribeHandlerConstants: {
        titleVal: "Feedly Cloud",
        typeVal: "application/vnd.mozilla.maybe.feed",
        uriVal: "https://cloud.feedly.com/#subscription/feed/%s"
    },
    //Firefox sdk doesn't support more than 1 notification at once
    maxNotificationsCount: 1,
    cachedFeeds: [],
    cachedSavedFeeds: [],
    isLoggedIn: false,
    intervalIds: [],
    widget: null,
    panel: null,
    clientId: "",
    clientSecret: ""
};

(function(){
    userstyles.load(self.data.url("styles/button.css"));

    options.on("", function (optionName) {
        appGlobal.options[optionName] = options.prefs[optionName];
        options.prefs[optionName] = appGlobal.options[optionName];
        initialize();
    });

    options.on("logout", function () {
        ffStorage.storage.accessToken = "";
        ffStorage.storage.refreshToken = "";
        initialize();
    });

    options.on("filters", function () {
        openFiltersTab();
    });
})();

/* Initialization button, panel and callback.
 * @param {Boolean} showPanel, if true, panel will be attached to widget
 * */
function controlsInitialization(showPanel){

    if(appGlobal.panel){
        appGlobal.panel.destroy();
    }

    if(appGlobal.widget){
        appGlobal.widget.destroy();
    }

    if(showPanel){
        appGlobal.panel = panelSdk.Panel({
            width: 400,
            height: 500,
            contentURL: self.data.url("popup.html"),
            contentScriptFile: [
                self.data.url("scripts/jquery-2.0.3.min.js"),
                self.data.url("scripts/jquery.mustache.min.js"),
                self.data.url("scripts/timeago/jquery.timeago.js"),
                self.data.url(_("TimeAgoLocalizedLink")),
                self.data.url("scripts/popup.js")
            ]
        });

        appGlobal.panel.port.on("resizePanel", function (size) {
            appGlobal.panel.resize(size.width, size.height);
        });

        appGlobal.panel.port.on("markRead", function (feedIds) {
            markAsRead(feedIds);
        });

        appGlobal.panel.on("show", function () {
            showPopupLoader();
            setInterface();
            getFeeds(function (data) {
                sendFeedsToPopup(data);
            });
        });

        appGlobal.panel.port.on("getFeeds", function (data) {
            showPopupLoader();
            if (data.isSavedFeeds) {
                getSavedFeeds(false, function (data) {
                    data.isSavedFeeds = true;
                    sendFeedsToPopup(data);
                });
            } else {
                var keepPopup = data.keepPopup;
                getFeeds(function (data) {
                    if (!data.feeds.length && appGlobal.options.closePopupWhenNoFeeds && !keepPopup) {
                        appGlobal.panel.hide();
                    } else {
                        sendFeedsToPopup(data);
                    }
                });
            }
        });

        appGlobal.panel.port.on("updateToken", function () {
            getAccessToken();
        });

        appGlobal.panel.port.on("openFeedTab", function (data) {
            openFeedTab(data.url, data.inBackground, data.feedId, data.isSaved);
        });

        appGlobal.panel.port.on("saveFeed", function (data) {
            toggleSavedFeed(data.feedId, data.saveStatus);
        });

        appGlobal.panel.port.on("openFeedlyTab", function () {
            openFeedlyTab();
        });
    }

    appGlobal.widget = widgetSdk.ToolbarWidget({
        toolbarID: "nav-bar",
        insertbefore: [ "search-container", "downloads-button", "home-button" ],
        forceMove: false,
        height: 20,
        width: 28,
        id: "main-widget",
        label: "Feedly Notifier",
        tooltip: "Feedly Notifier",
        contentURL: self.data.url("widget.html"),
        contentScriptFile: self.data.url("scripts/widget.js"),
        panel: appGlobal.panel,
        autoShrink: false
    });

    appGlobal.widget.on("attach", function(){
        updateCounter();
        updateFeeds();
    });

    appGlobal.widget.port.on("middle-click", function(){
        executeClickAction(appGlobal.options.middleClick);
    });

    appGlobal.widget.port.on("left-click", function(){
        executeClickAction(appGlobal.options.leftClick);
    });

    appGlobal.widget.port.on("right-click", function(){
        executeClickAction(appGlobal.options.rightClick);
    });

    function executeClickAction(action){
        switch (action){
            case appGlobal.clickActions.showPopup:
                resetCounter();
                break;
            case appGlobal.clickActions.openSite:
                openSite();
                resetCounter();
                break;
            case appGlobal.clickActions.update:
                update();
                break;
            case appGlobal.clickActions.none:
                break;
        }

        function openSite(){
            if (appGlobal.isLoggedIn) {
                openFeedlyTab();
            } else {
                getAccessToken();
            }
        }

        function update() {
            startWidgetUpdateAnimation();
            updateCounter(function () {
                stopWidgetUpdateAnimation();
            });
            updateFeeds();
            updateSavedFeeds();
        }

        function resetCounter() {
            if (appGlobal.options.resetCounterOnClick) {
                sendUnreadFeedsCount({unreadFeedsCount: 0, isLoggedIn: appGlobal.isLoggedIn});
                ffStorage.storage.lastCounterResetTime = new Date().getTime();
            }
        }
    }
}

/* Senders */
function sendFeedsToPopup(feedsData) {
    appGlobal.panel.port.emit("feedsUpdated", feedsData);
}

function showPopupLoader() {
    appGlobal.panel.port.emit("showLoader", null);
}

function setInterface() {
    appGlobal.panel.port.emit("setPopupInterface", {
        abilitySaveFeeds: appGlobal.options.abilitySaveFeeds,
        popupFontSize: appGlobal.options.popupFontSize,
        showCategories: appGlobal.options.showCategories
    });
}

function sendMarkAsReadResult(feedIds) {
    appGlobal.panel.port.emit("feedMarkedAsRead", feedIds);
}

function sendUnreadFeedsCount(unreadFeedsData) {
    if(!appGlobal.options.showCounter) unreadFeedsData.unreadFeedsCount = 0;
    appGlobal.widget.port.emit("onFeedsUpdate", unreadFeedsData);
}

function decrementFeedsCount(number){
    appGlobal.widget.port.emit("decrementFeedsCount", number);
}

function sendRemoveFeedsFromPopup(feedIds){
    appGlobal.panel.port.emit("removeFeedsFromPopup", feedIds);
}

function startWidgetUpdateAnimation(){
    appGlobal.widget.port.emit("startWidgetUpdateAnimation");
}

function stopWidgetUpdateAnimation(){
    appGlobal.widget.port.emit("stopWidgetUpdateAnimation");
}

/* Core functional */

/* Initializes api client, stops scheduler and runs new one */
function initialize() {
    if (appGlobal.options.leftClick !== appGlobal.clickActions.showPopup) {
        controlsInitialization(false);
    } else {
        controlsInitialization(true);
    }

    appGlobal.feedlyApiClient.accessToken = ffStorage.storage.accessToken;

    //TODO: Remove this fallback in next versions
    if (!ffStorage.storage.feedlyUserId) {
        apiRequestWrapper("profile", {
            onSuccess: function(response){
                ffStorage.storage.feedlyUserId = response.id;
                startSchedule(appGlobal.options.updateInterval);
            }
        })
    } else {
        startSchedule(appGlobal.options.updateInterval);
    }
}

/* Starts new scheduler */
function startSchedule(updateInterval) {
    stopSchedule();

    updateCounter();
    updateFeeds();
    updateSavedFeeds();

    if(appGlobal.options.showCounter){
        appGlobal.intervalIds.push(timers.setInterval(updateCounter, updateInterval * 60000));
    }
    if (appGlobal.options.showDesktopNotifications || appGlobal.options.playSound || !appGlobal.options.openSiteOnIconClick) {
        appGlobal.intervalIds.push(timers.setInterval(updateFeeds, updateInterval * 60000));
    }
}

/* Stops scheduler */
function stopSchedule() {
    appGlobal.intervalIds.forEach(function(intervalId){
        timers.clearInterval(intervalId);
    });
    appGlobal.intervalIds = [];
}

/* Sends desktop notifications */
function sendDesktopNotification(feeds) {
    //if notifications too many, then to show only count
    if (feeds.length > appGlobal.maxNotificationsCount) {
        //We can detect only limit count of new feeds at time, but actually count of feeds may be more
        var count = feeds.length === appGlobal.options.maxNumberOfFeeds ? _("many") : feeds.length.toString();
        notifications.notify({
            title: _("NewFeeds"),
            text: _("YouHaveNewFeeds", count),
            iconURL: self.data.url(appGlobal.icons.default)
        });
    } else {
        for (var i = 0; i < feeds.length; i++) {
            notifications.notify({
                title: feeds[i].blog,
                text: feeds[i].title,
                iconURL: feeds[i].blogIcon,
                data: JSON.stringify(feeds[i]),
                onClick: function (feed) {
                    var feed = JSON.parse(feed);
                    openFeedTab(feed.url, false, feed.id);
                }
            });
        }
    }
}

/* Plays alert sound */
function playSound(){
    pageWorker.Page({
        contentScript: "new Audio('sound/alert.oga').play()",
        contentURL: self.data.url("blank.html")
    });
}

/* Returns only new feeds and set date of last feed */
function filterByNewFeeds(feeds) {
    var lastFeedTime = new Date(ffStorage.storage.lastFeedTime || 0);
    var maxFeedTime = lastFeedTime;
    var newFeeds = [];

    for (var i = 0; i < feeds.length; i++) {
        if (feeds[i].date > lastFeedTime) {
            newFeeds.push(feeds[i]);
            if (feeds[i].date > maxFeedTime) {
                maxFeedTime = feeds[i].date;
            }
        }
    }

    ffStorage.storage.lastFeedTime = maxFeedTime.getTime();
    return newFeeds;
}

/* Removes feeds from cache by feed ID */
function removeFeedFromCache(feedId) {
    var indexFeedForRemove;
    for (var i = 0; i < appGlobal.cachedFeeds.length; i++) {
        if (appGlobal.cachedFeeds[i].id === feedId) {
            indexFeedForRemove = i;
            break;
        }
    }

    //Remove feed from cached feeds
    if (indexFeedForRemove !== undefined) {
        appGlobal.cachedFeeds.splice(indexFeedForRemove, 1);
    }
}

function openFiltersTab() {
    var filtersUrl = self.data.url("filters.html");
    if (appGlobal.filtersTab && new RegExp(appGlobal.filtersTab.url, "i").test(filtersUrl)) {
        appGlobal.filtersTab.reload();
        appGlobal.filtersTab.activate();
    } else {
        tabs.open({
            url: filtersUrl,
            onOpen: function (tab) {
                appGlobal.filtersTab = tab;
            },
            onClose: function () {
                appGlobal.filtersTab = null;
            },
            onReady: function(tab){
                var worker = tab.attach({
                    contentScriptFile: [
                        self.data.url("scripts/jquery-2.0.3.min.js"),
                        self.data.url("scripts/jquery.mustache.min.js"),
                        self.data.url("scripts/filters.js")
                    ]
                });
                getCategories(function(categories){
                    worker.port.emit("getCategories", categories)
                });
                worker.port.on("updateToken", function(){
                    getAccessToken();
                });

                worker.port.on("getFilters", function(){
                    worker.port.emit("returnFilters", {filters: appGlobal.options.filters, isFiltersEnabled: appGlobal.options.isFiltersEnabled});
                });

                worker.port.on("saveFilters", function(filterData){
                    appGlobal.options.filters = ffStorage.storage.filters = filterData.filters;
                    if(options.prefs.isFiltersEnabled === filterData.isFiltersEnabled) {
                        initialize();
                    } else {
                        options.prefs.isFiltersEnabled = filterData.isFiltersEnabled;
                    }
                });
            }
        });
    }
}

function openFeedlyTab() {
    if (appGlobal.feedlyTab && new RegExp(appGlobal.feedlyUrl, "i").test(appGlobal.feedlyTab.url)) {
        appGlobal.feedlyTab.reload();
        appGlobal.feedlyTab.activate();
    } else {
        tabs.open({
            url: appGlobal.feedlyUrl,
            onOpen: function (tab) {
                appGlobal.feedlyTab = tab;
            },
            onClose: function () {
                appGlobal.feedlyTab = null;
            }
        });
    }

    if (appGlobal.panel && appGlobal.panel.isShowing && appGlobal.options.closePopupOnNewsOpen) {
        appGlobal.panel.hide();
    }
}

function openFeedTab(url, inBackground, feedId, isSaved) {
    tabs.open({
        url: url,
        inBackground: inBackground,
        onOpen: function(){
            if (appGlobal.options.markReadOnClick && feedId && !isSaved) {
                markAsRead([feedId]);
            }
            if (!inBackground && appGlobal.panel && appGlobal.panel.isShowing && appGlobal.options.closePopupOnNewsOpen) {
                appGlobal.panel.hide();
            }
        }
    });
}

/* Stops scheduler, sets badge as inactive and resets counter */
function setInactiveStatus() {
    stopWidgetUpdateAnimation();
    sendUnreadFeedsCount({unreadFeedsCount: 0, isLoggedIn: false});
    appGlobal.cachedFeeds = [];
    appGlobal.isLoggedIn = false;
    stopSchedule();
}

/* Sets badge as active */
function setActiveStatus() {
    appGlobal.isLoggedIn = true;
}

/* Runs feeds update and stores unread feeds in cache
 * Callback will be started after the function will be completed
 * */
function updateCounter(callback) {
    if(appGlobal.options.resetCounterOnClick){
            if (ffStorage.storage.lastCounterResetTime){
                var parameters = {
                    newerThan: ffStorage.storage.lastCounterResetTime
                };
            }
            makeMarkersRequest(parameters);
    } else {
        ffStorage.storage.lastCounterResetTime = new Date(0).getTime();
        makeMarkersRequest();
    }

    function makeMarkersRequest(parameters){
        apiRequestWrapper("markers/counts", {
            parameters: parameters,
            onSuccess: function (response) {
                var unreadCounts = response.unreadcounts;
                var unreadFeedsCount = 0;

                if (appGlobal.options.isFiltersEnabled) {
                    apiRequestWrapper("subscriptions", {
                        onSuccess: function (response) {
                            unreadCounts.forEach(function (element) {
                                if (appGlobal.options.filters.indexOf(element.id) !== -1) {
                                    unreadFeedsCount += element.count;
                                }
                            });

                            // When feed consists in more than one category, we remove feed which was counted twice or more
                            response.forEach(function (feed) {
                                var numberOfDupesCategories = 0;
                                feed.categories.forEach(function(category){
                                    if(appGlobal.options.filters.indexOf(category.id) !== -1){
                                        numberOfDupesCategories++;
                                    }
                                });
                                if(numberOfDupesCategories > 1){
                                    for (var i = 0; i < unreadCounts.length; i++) {
                                        if (feed.id === unreadCounts[i].id) {
                                            unreadFeedsCount -= unreadCounts[i].count * --numberOfDupesCategories;
                                            break;
                                        }
                                    }
                                }
                            });

                            sendUnreadFeedsCount({unreadFeedsCount: unreadFeedsCount, isLoggedIn: true});

                            if (typeof callback === "function") {
                                callback();
                            }
                        }
                    });
                } else {
                    for (var i = 0; i < unreadCounts.length; i++) {
                        if (appGlobal.globalGroup === unreadCounts[i].id) {
                            unreadFeedsCount = unreadCounts[i].count;
                            break;
                        }
                    }

                    sendUnreadFeedsCount({unreadFeedsCount: unreadFeedsCount, isLoggedIn: true});

                    if (typeof callback === "function") {
                        callback();
                    }
                }
            }
        });
    }
}

/* Runs feeds update and stores unread feeds in cache
 * Callback will be started after function complete
 * If silentUpdate is true, then notifications will not be shown
 *  */
function updateFeeds(callback, silentUpdate) {
    appGlobal.cachedFeeds = [];
    appGlobal.options.filters = appGlobal.options.filters || [];

    var streamIds = appGlobal.options.isFiltersEnabled && appGlobal.options.filters.length ? appGlobal.options.filters : [appGlobal.globalGroup];

    var requestCount = streamIds.length;

    for (var i = 0; i < streamIds.length; i++) {
        apiRequestWrapper("streams/" + encodeURIComponent(streamIds[i]) + "/contents", {
            parameters: {
                unreadOnly: true,
                ranked: appGlobal.options.oldestFeedsFirst ? "oldest" : "newest",
                count: appGlobal.options.maxNumberOfFeeds
            },
            onSuccess: function (response) {
                requestCount--;

                appGlobal.cachedFeeds = appGlobal.cachedFeeds.concat(parseFeeds(response));

                if (requestCount < 1) {

                    // Remove duplicates
                    appGlobal.cachedFeeds = appGlobal.cachedFeeds.filter(function (value, index, feeds) {
                        for (var i = ++index; i < feeds.length; i++) {
                            if (feeds[i].id == value.id) {
                                return false;
                            }
                        }
                        return true;
                    });

                    appGlobal.cachedFeeds = appGlobal.cachedFeeds.sort(function (a, b) {
                        if (a.date > b.date) {
                            return appGlobal.options.oldestFeedsFirst ? 1 : -1;
                        } else if (a.date < b.date) {
                            return appGlobal.options.oldestFeedsFirst ? -1 : 1;
                        }
                        return 0;
                    });

                    appGlobal.cachedFeeds = appGlobal.cachedFeeds.splice(0, appGlobal.options.maxNumberOfFeeds);
                    if (appGlobal.options.showDesktopNotifications) {
                        var newFeeds = filterByNewFeeds(appGlobal.cachedFeeds);
                        if (!silentUpdate) {
                            sendDesktopNotification(newFeeds);
                        }
                        if (appGlobal.options.playSound && newFeeds.length > 0) {
                            playSound();
                        }
                    }
                    if (typeof callback === "function") {
                        callback();
                    }
                }
            },
            onAuthorizationRequired: function () {
                if (typeof callback === "function") {
                    callback();
                }
            }
        });
    }
}

/* Update saved feeds and stores its in cache */
function updateSavedFeeds(callback) {
    apiRequestWrapper("streams/" + encodeURIComponent(appGlobal.savedGroup) + "/contents", {
        onSuccess: function (response) {
            appGlobal.cachedSavedFeeds = parseFeeds(response);
            if (typeof callback === "function") {
                callback();
            }
        }
    });
}

/* Converts feedly response to feeds */
function parseFeeds(feedlyResponse) {
    var feeds = feedlyResponse.items.map(function (item) {
        var blogUrl;
        try {
            blogUrl = item.origin.htmlUrl.match(/http(?:s)?:\/\/[^/]+/i).pop();
        } catch (exception) {
            blogUrl = "#";
        }

        //Set content
        var content;
        var contentDirection;
        if (appGlobal.options.showFullFeedContent) {
            if (item.content) {
                content = item.content.content;
                contentDirection = item.content.direction;
            }
        }
        if (!content) {
            if (item.summary) {
                content = item.summary.content;
                contentDirection = item.summary.direction;
            }
        }

        //Set title
        var title;
        var titleDirection;
        if (item.title) {
            if (item.title.indexOf("direction:rtl") !== -1) {
                //Feedly wraps rtl titles in div, we remove div because desktopNotification supports only text
                title = item.title.replace(/<\/?div.*?>/gi, "");
                titleDirection = "rtl";
            } else {
                title = item.title;
            }
        }

        var isSaved = false;
        if (item.tags) {
            for (var i = 0; i < item.tags.length; i++) {
                if (item.tags[i].id.search(/global\.saved$/i) !== -1) {
                    isSaved = true;
                    break;
                }
            }
        }

        var blog;
        var blogTitleDirection;
        if (item.origin && item.origin.title) {
            if (item.origin.title.indexOf("direction:rtl") !== -1) {
                //Feedly wraps rtl titles in div, we remove div because desktopNotification supports only text
                blog = item.origin.title.replace(/<\/?div.*?>/gi, "");
                blogTitleDirection = "rtl";
            } else {
                blog = item.origin.title;
            }
        }

        var categories = [];
        if (item.categories) {
            categories = item.categories.map(function (category){
                return {
                    id: category.id,
                    encodedId: encodeURI(category.id),
                    label: category.label
                };
            });
        }

        return {
            //Feedly wraps rtl titles in div, we remove div because desktopNotification supports only text
            title: title,
            titleDirection: titleDirection,
            url: item.alternate ? item.alternate[0] ? item.alternate[0].href : "" : "",
            blog: blog,
            blogTitleDirection: blogTitleDirection,
            blogUrl: blogUrl,
            blogIcon: "https://www.google.com/s2/favicons?domain=" + blogUrl + "&alt=feed",
            id: item.id,
            content: content,
            contentDirection: contentDirection,
            isoDate: item.crawled ? new Date(item.crawled).toISOString() : "",
            date: item.crawled ? new Date(item.crawled) : "",
            isSaved: isSaved,
            categories: categories
        };
    });
    return feeds;
}

/* Marks feed as read, remove it from the cache and decrement badge.
 * array of the ID of feeds
 */
function markAsRead(feedIds) {
    apiRequestWrapper("markers", {
        method: "POST",
        body: {
            action: "markAsRead",
            type: "entries",
            entryIds: feedIds
        },
        onSuccess: function(){
            for (var i = 0; i < feedIds.length; i++) {
                removeFeedFromCache(feedIds[i]);
            }
            sendMarkAsReadResult(feedIds);
            decrementFeedsCount(feedIds.length);
        }
    });
    sendRemoveFeedsFromPopup(feedIds);
}

/* Reads all options from the storage */
function readOptions() {
    for (var optionName in appGlobal.options) {
        appGlobal.options[optionName] = options.prefs[optionName];
    }
    // options.prefs doesn't support arrays
    appGlobal.options.filters = ffStorage.storage.filters;
}

/* Save feed or unsave it.
 * feed ID
 * if saveStatus is true, then save feed, else unsafe it */
function toggleSavedFeed(feedId, saveStatus) {
    if (saveStatus) {
        apiRequestWrapper("tags/" + encodeURIComponent(appGlobal.savedGroup), {
            method: "PUT",
            body: {
                entryId: feedId
            },
            onSuccess: function (response) {
                updateSavedFeeds();
            }
        });
    } else {
        apiRequestWrapper("tags/" + encodeURIComponent(appGlobal.savedGroup) + "/" + encodeURIComponent(feedId), {
            method: "DELETE",
            onSuccess: function (response) {
                updateSavedFeeds();
            }
        });
    }

    //Update state in the cache
    for (var i = 0; i < appGlobal.cachedFeeds.length; i++) {
        if (appGlobal.cachedFeeds[i].id === feedId) {
            appGlobal.cachedFeeds[i].isSaved = saveStatus;
            break;
        }
    }
}

/* Runs authenticating a user process,
 * then read access token and stores in the FF storage */
function getAccessToken() {
    var state = (new Date()).getTime();
    var url = appGlobal.feedlyApiClient.getMethodUrl("auth/auth", {
        response_type: "code",
        client_id: appGlobal.clientId,
        redirect_uri: "http://localhost",
        scope: "https://cloud.feedly.com/subscriptions",
        state: state
    }, appGlobal.options.useSecureConnection);

    // In some cases onLoad doesn't work properly, thus we use all events for fallback
    tabs.on("ready", requestToken);
    tabs.on("load", requestToken);
    tabs.on("pageshow", requestToken);

    tabs.open({
        url: url
    });

    var tokenRequestStarted;
    function requestToken(tab){

        var checkStateRegex = new RegExp("state=" + state);
        if (!checkStateRegex.test(tab.url)) {
            return;
        }

        var codeParse = /code=(.+?)(?:&|$)/i;
        var matches = codeParse.exec(tab.url);

        if (tokenRequestStarted) return;

        if (matches) {
            tokenRequestStarted = true;
            appGlobal.feedlyApiClient.request("auth/token", {
                method: "POST",
                useSdkRequest: true,
                useSecureConnection: appGlobal.options.useSecureConnection,
                parameters: {
                    code: matches[1],
                    client_id: appGlobal.clientId,
                    client_secret: appGlobal.clientSecret,
                    redirect_uri: "http://localhost",
                    grant_type: "authorization_code"
                },
                onSuccess: function (response) {
                    ffStorage.storage.accessToken = response.access_token;
                    ffStorage.storage.refreshToken = response.refresh_token;
                    ffStorage.storage.feedlyUserId = response.id;

                    tabs.removeListener("ready", requestToken);
                    tabs.removeListener("load", requestToken);
                    tabs.removeListener("pageshow", requestToken);

                    tab.close();
                    initialize();
                }
            });
        }
    }
}

/* Tries refresh access token if possible */
function refreshAccessToken(){
    if(!ffStorage.storage.refreshToken) return;

    appGlobal.feedlyApiClient.request("auth/token", {
        method: "POST",
        useSdkRequest: true,
        useSecureConnection: appGlobal.options.useSecureConnection,
        parameters: {
            refresh_token: ffStorage.storage.refreshToken,
            client_id: appGlobal.clientId,
            client_secret: appGlobal.clientSecret,
            grant_type: "refresh_token"
        },
        onSuccess: function (response) {
            ffStorage.storage.feedlyUserId = response.id;
            ffStorage.storage.accessToken = response.access_token;
            initialize();
        },
        onComplete: function(){
            ffStorage.storage.authorizationWasRequested = false;
        }
    });
}

/* Returns feeds from the cache.
 If the cache is empty, then it will be updated before return */
function getFeeds(callback) {
    if (appGlobal.cachedFeeds.length > 0) {
        callback({feeds: appGlobal.cachedFeeds.slice(0), isLoggedIn: appGlobal.isLoggedIn});
    } else {
        updateFeeds(function () {
            callback({feeds: appGlobal.cachedFeeds.slice(0), isLoggedIn: appGlobal.isLoggedIn});
        }, true);
        updateCounter();
    }
}

/* Returns saved feeds from the cache.
 * If the cache is empty, then it will be updated before return
 * forceUpdate, when is true, then cache will be updated
 */
function getSavedFeeds(forceUpdate, callback) {
    if (appGlobal.cachedSavedFeeds.length > 0 && !forceUpdate) {
        callback({feeds: appGlobal.cachedSavedFeeds.slice(0), isLoggedIn: appGlobal.isLoggedIn});
    } else {
        updateSavedFeeds(function () {
            callback({feeds: appGlobal.cachedSavedFeeds.slice(0), isLoggedIn: appGlobal.isLoggedIn});
        });
    }
}

/* Gets categories for current user
 * if user is not logged in, then returns empty array
 */
function getCategories(callback){
    apiRequestWrapper("categories", {
        onSuccess: function (response) {
            response.push({
                id: appGlobal.globalUncategorized,
                label: "Uncategorized"
            });
            callback(response);
        },
        onAuthorizationRequired: function (){
            callback([]);
        }
    });
}

function apiRequestWrapper(methodName, settings) {
    var onSuccess = settings.onSuccess;
    settings.onSuccess = function (response) {
        ffStorage.storage.authorizationWasRequested = false;
        setActiveStatus();
        if (typeof onSuccess === "function") {
            onSuccess(response);
        }
    };

    var onAuthorizationRequired = settings.onAuthorizationRequired;

    settings.onAuthorizationRequired = function (accessToken) {
        if (!ffStorage.storage.authorizationWasRequested) {
            setInactiveStatus();
            refreshAccessToken();
            ffStorage.storage.authorizationWasRequested = true;
        }
        if (typeof onAuthorizationRequired === "function") {
            onAuthorizationRequired(accessToken);
        }
    };

    appGlobal.feedlyApiClient.request(methodName, settings);
}

exports.main = function (options, callbacks) {
    readOptions();
    initialize();

    if (options.loadReason !== "startup") {
        // Register the handler so it'll take effect without restarting
        Cc["@mozilla.org/embeddor.implemented/web-content-handler-registrar;1"]
            .getService(Ci.nsIWebContentHandlerRegistrar)
            .registerContentHandler(appGlobal.subscribeHandlerConstants.typeVal, appGlobal.subscribeHandlerConstants.uriVal, appGlobal.subscribeHandlerConstants.titleVal, null);
    }
};

exports.onUnload = function (reason) {

    if (reason !== "shutdown") {
        var handlerNumber = -1;
        var handlerFound = false;

        var keyPrefix = "browser.contentHandlers.types.";
        var titleKey = ".title";
        var uriKey = ".uri";
        var typeKey = ".type";

        while (!handlerFound) {
            handlerNumber++;
            var handlerTitle = prefs.get(keyPrefix + handlerNumber + titleKey);
            if (!handlerTitle) {
                break;
            }
            handlerFound = handlerTitle === appGlobal.subscribeHandlerConstants.titleVal;
        }

        if (handlerFound) {
            // Remove the prefs, otherwise if it gets re-enabled this session it'll
            // keep incrementing the content handler number when it registers
            prefs.reset(keyPrefix + handlerNumber + titleKey);
            prefs.reset(keyPrefix + handlerNumber + uriKey);
            prefs.reset(keyPrefix + handlerNumber + typeKey);

            // If it's set as the "always use", clear that.
            // TODO: Figure out how to make this work without a restart
            var autoSubscribeKey = "browser.contentHandlers.auto.application/vnd.mozilla.maybe.feed";
            if (prefs.get(autoSubscribeKey) === appGlobal.subscribeHandlerConstants.uriVal) {
                prefs.reset(autoSubscribeKey);
            }

            // Unregister the handler, so it'll take effect without restarting
            Cc["@mozilla.org/embeddor.implemented/web-content-handler-registrar;1"]
                .getService(Ci.nsIWebContentConverterService)
                .removeContentHandler(appGlobal.subscribeHandlerConstants.typeVal, appGlobal.subscribeHandlerConstants.uriVal);
        }
    }
};