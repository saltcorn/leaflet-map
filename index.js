const { features } = require("@saltcorn/data/db/state");
const headers =
  features && features.deep_public_plugin_serve
    ? [
        {
          script: `/plugins/public/leaflet-map@${
            require("./package.json").version
          }/leaflet.js`,
        },
        {
          css: `/plugins/public/leaflet-map@${
            require("./package.json").version
          }/leaflet.css`,
        },
      ]
    : [
        {
          script: "https://unpkg.com/leaflet@1.6.0/dist/leaflet.js",
          integrity:
            "sha512-gZwIG9x3wUXg2hdXF6+rVkLF/0Vi9U8D2Ntg4Ga5I5BZpVkVxlJWbSQtXPSiUTtC0TjtGOmxa1AJPuV0CPthew==",
        },
        {
          css: "https://unpkg.com/leaflet@1.6.0/dist/leaflet.css",
          integrity:
            "sha512-xwE/Az9zrjBIphAcBb3F6JVqxf46+CDLwfLMHloNu6KEQCAWi6HcDUbeOfBIptF7tcCzusKFjFw2yuvEpDL9wQ==",
        },
      ];

module.exports = {
  sc_plugin_api_version: 1,
  headers,
  plugin_name: "leaflet-map",
  viewtemplates: [require("./map"), require("./multi-table-map")],
};
