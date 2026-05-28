Vue.filter('currency', function (value, currency) {
    if (isNaN(value)) {
        return value;
    } else {
        return value = '$' + parseFloat(value).toFixed(2);
    }
});

function getParameter(name, url) {
    if (!url) {
      url = window.location.href;
    }
    name = name.replace(/[\[\]]/g, "\\$&");
    var regex = new RegExp("[?&]" + name + "(=([^&#]*)|&|#|$)"),
        results = regex.exec(url);
    if (!results) return null;
    if (!results[2]) return '';
    return decodeURIComponent(results[2].replace(/\+/g, " "));
}

function getUrl() {
    return window.location.href;
}