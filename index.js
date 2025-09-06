const { features } = require("@saltcorn/data/db/state");
const headers = [
  {
    script: `/plugins/public/leaflet-map@${
      require("./package.json").version
    }/leaflet.js`,
    onlyViews: ["Leaflet map", "Leaflet map - multi-table"],
  },
  {
    css: `/plugins/public/leaflet-map@${
      require("./package.json").version
    }/leaflet.css`,
    onlyViews: ["Leaflet map", "Leaflet map - multi-table"],
  },
];

module.exports = {
  sc_plugin_api_version: 1,
  headers,
  plugin_name: "leaflet-map",
  viewtemplates: [require("./map"), require("./multi-table-map")],
};
