const { div, script, domReady } = require("@saltcorn/markup/tags");
const View = require("@saltcorn/data/models/view");
const Workflow = require("@saltcorn/data/models/workflow");
const Table = require("@saltcorn/data/models/table");
const Form = require("@saltcorn/data/models/form");
const Field = require("@saltcorn/data/models/field");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");

const { stateFieldsToWhere } = require("@saltcorn/data/plugin-helper");
const { fetchGeoJSON } = require("./postgis-utils");

const isNode = typeof window === "undefined";

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "views",
        form: async (context) => {
          const tables = await Table.find({});
          const lat_long_options = {};
          const all_field_options = {};
          const popview_options = {};
          for (const table of tables) {
            const fields = await table.getFields();
            lat_long_options[table.name] = fields
              .filter((f) => f.type.name === "Float")
              .map((f) => f.name);
            const geomTypeNames = new Set(["PostGIS Geometry", "PostGIS Geography"]);
            const geomFields = fields.filter((f) => geomTypeNames.has(f.type?.name));
            const otherFields = fields.filter((f) => !geomTypeNames.has(f.type?.name));
            all_field_options[table.name] = [
              ...geomFields.map((f) => ({ label: `${f.name} (${f.type.name})`, name: f.name })),
              ...otherFields.map((f) => ({ label: f.name, name: f.name })),
            ];
            const popup_views = await View.find_table_views_where(
              table.id,
              ({ viewtemplate }) => viewtemplate.runMany,
            );
            popup_views.unshift({ name: "" });
            popview_options[table.name] = popup_views.map((v) => v.name);
          }

          return new Form({
            fields: [
              new FieldRepeat({
                name: "map_tables",
                fields: [
                  {
                    name: "table_name",
                    label: "Table",
                    type: "String",
                    required: true,
                    attributes: { options: tables.map((t) => t.name) },
                  },
                  {
                    name: "popup_view",
                    label: "Popup view",
                    sublabel: "Blank for no popup",
                    type: "String",
                    attributes: {
                      calcOptions: ["table_name", popview_options],
                    },
                  },
                  {
                    name: "postgis_geometry_field",
                    label: "PostGIS geometry field",
                    type: "String",
                    sublabel: "Optional: use instead of lat/lng fields.",
                    required: false,
                    attributes: {
                      calcOptions: ["table_name", all_field_options],
                    },
                  },
                  {
                    name: "latitude_field",
                    label: "Latitude field",
                    type: "String",
                    sublabel:
                      "Float field for latitude. Required if no PostGIS geometry field is set.",
                    required: false,
                    attributes: {
                      calcOptions: ["table_name", lat_long_options],
                    },
                  },
                  {
                    name: "longtitude_field",
                    label: "Longtitude field",
                    type: "String",
                    sublabel:
                      "Float field for longitude. Required if no PostGIS geometry field is set.",
                    required: false,
                    attributes: {
                      calcOptions: ["table_name", lat_long_options],
                    },
                  },
                ],
              }),
              {
                name: "height",
                label: "Height in px",
                type: "Integer",
                required: true,
                default: 300,
              },
              {
                name: "popup_width",
                label: "Popup width in px",
                type: "Integer",
                required: true,
                default: 300,
              },
            ],
          });
        },
      },
    ],
  });

const get_state_fields = async () => [];

const mobileImgLoader = () => `
    .on('click', function() {
      $("[mobile-img-path]").each(async function () {
        if (parent.loadEncodedFile) {
          const theImg = $(this);
          const src = theImg.attr("src");
          if (!src || !src.startsWith("data:image")) {
            const fileId = theImg.attr("mobile-img-path");
            const base64Encoded = await parent.loadEncodedFile(fileId);
            this.src = base64Encoded;
          }
        }
      });
    })`;

const run = async (
  _table_id,
  _viewname,
  { map_tables, popup_width, height },
  state,
  extraArgs,
  queriesObj,
) => {
  const id = `map${Math.round(Math.random() * 100000)}`;
  const points = []; // [[lat,lng], html?] rendered as L.marker
  const features = []; // GeoJSON Feature objects rendered as L.geoJSON
  const cache = {};

  for (const {
    table_name,
    popup_view,
    latitude_field,
    longtitude_field,
    postgis_geometry_field,
  } of map_tables) {
    if (postgis_geometry_field) {
      // PostGIS geometry path
      const tbl = await Table.findOne({ name: table_name });
      const pk = tbl.pk_name || "id";
      let rows = [];
      const htmlByPk = {};

      if (popup_view) {
        const popview = await View.findOne({ name: popup_view });
        if (!popview)
          return div(
            { class: "alert alert-danger" },
            "Leaflet map incorrectly configured. Cannot find view: ",
            popup_view,
          );
        if (!cache[popup_view])
          cache[popup_view] = await popview.runMany(state, { ...extraArgs });
        const popresps = cache[popup_view];
        rows = popresps.map((p) => p.row);
        for (const { html, row } of popresps) htmlByPk[row[pk]] = html;
      } else {
        rows = queriesObj?.get_rows_query
          ? await queriesObj.get_rows_query(state, table_name)
          : await getRowsQueryImpl(state, table_name);
      }

      if (rows.length > 0) {
        const geomById = await fetchGeoJSON(
          tbl,
          postgis_geometry_field,
          rows.map((r) => r[pk]),
        );
        for (const row of rows) {
          const geom = geomById[row[pk]];
          if (!geom) continue;
          features.push({
            type: "Feature",
            geometry: geom,
            properties: { popup: htmlByPk[row[pk]] || null },
          });
        }
      }
    } else {
      if (popup_view) {
        const popview = await View.findOne({ name: popup_view });
        if (!popview)
          return div(
            { class: "alert alert-danger" },
            "Leaflet map incorrectly configured. Cannot find view: ",
            popup_view,
          );
        if (!cache[popup_view])
          cache[popup_view] = await popview.runMany(state, { ...extraArgs });
        const popresps = cache[popup_view];
        points.push(
          ...popresps.map(({ html, row }) => [
            [row[latitude_field], row[longtitude_field]],
            html,
          ]),
        );
      } else {
        const rows = queriesObj?.get_rows_query
          ? await queriesObj.get_rows_query(state, table_name)
          : await getRowsQueryImpl(state, table_name);
        points.push(
          ...rows.map((row) => [[row[latitude_field], row[longtitude_field]]]),
        );
      }
    }
  }

  if (points.length === 0 && features.length === 0) return div("No locations");

  const maxW = (popup_width || 300) + 5;
  const minW = (popup_width || 300) - 5;

  return (
    div({ id, style: `height:${height}px;` }) +
    script(
      domReady(`
var map = L.map('${id}');
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

var _bounds = L.latLngBounds();

// Lat/lng markers
var _points = ${JSON.stringify(points)};
_points.forEach(pt=>{
  var marker = L.marker(pt[0]).addTo(map);
  if (pt[1]) marker.bindPopup(pt[1], {maxWidth:${maxW},minWidth:${minW}})${
    isNode ? "" : mobileImgLoader()
  };
  _bounds.extend(pt[0]);
});

// PostGIS geometry layer
var _features = ${JSON.stringify(features)};
if (_features.length) {
  var _geojson = L.geoJSON({type:"FeatureCollection",features:_features}, {
    style: {color:"#3388ff", fillColor:"#3388ff", fillOpacity:0.2},
    pointToLayer: function(_f, latlng) { return L.marker(latlng); },
    onEachFeature: function(f, layer) {
      if (f.properties && f.properties.popup)
        layer.bindPopup(f.properties.popup, {maxWidth:${maxW},minWidth:${minW}})${
          isNode ? "" : mobileImgLoader()
        };
    }
  }).addTo(map);
  try { _bounds.extend(_geojson.getBounds()); } catch(e) {}
}

if (_bounds.isValid()) map.fitBounds(_bounds);

let prevVisibility=false;
let observer=new IntersectionObserver(()=>{
  const nowVisibile=$("#${id}").is(":visible");
  if(!prevVisibility&&nowVisibile) map.invalidateSize();
  prevVisibility=nowVisibile;
});
observer.observe(document.querySelector("#${id}"));
`),
    )
  );
};

const getRowsQueryImpl = async (state, table_name) => {
  const tbl = await Table.findOne({ name: table_name });
  const fields = await tbl.getFields();
  const qstate = await stateFieldsToWhere({ fields, state });
  return await tbl.getRows(qstate);
};

module.exports = {
  name: "Leaflet map - multi-table",
  display_state_form: false,
  get_state_fields,
  configuration_workflow,
  run,
  queries: ({}) => ({
    async get_rows_query(state, table_name) {
      return await getRowsQueryImpl(state, table_name);
    },
  }),
  tableless: true,
};
