const {
  input,
  div,
  text,
  script,
  domReady,
  style
} = require("@saltcorn/markup/tags");
const View = require("@saltcorn/data/models/view");
const Workflow = require("@saltcorn/data/models/workflow");
const Table = require("@saltcorn/data/models/table");
const Form = require("@saltcorn/data/models/form");
const Field = require("@saltcorn/data/models/field");
const { stateFieldsToWhere } = require("@saltcorn/data/plugin-helper");
const headers = [
  {
    script: "https://unpkg.com/leaflet@1.6.0/dist/leaflet.js",
    integrity:
      "sha512-gZwIG9x3wUXg2hdXF6+rVkLF/0Vi9U8D2Ntg4Ga5I5BZpVkVxlJWbSQtXPSiUTtC0TjtGOmxa1AJPuV0CPthew=="
  },
  {
    css: "https://unpkg.com/leaflet@1.6.0/dist/leaflet.css",
    integrity:
      "sha512-xwE/Az9zrjBIphAcBb3F6JVqxf46+CDLwfLMHloNu6KEQCAWi6HcDUbeOfBIptF7tcCzusKFjFw2yuvEpDL9wQ=="
  }
];

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "views",
        form: async context => {
          const table = await Table.findOne({ id: context.table_id });
          const fields = await table.getFields();

          const popup_views = await View.find_table_views_where(
            context.table_id,
            ({ viewtemplate, viewrow }) =>
              viewtemplate.runMany && viewrow.name !== context.viewname
          );
          const popup_view_opts = popup_views.map(v => v.name);

          return new Form({
            fields: [
              {
                name: "popup_view",
                label: "Popup view",
                sublabel: "Blank for no popup",
                type: "String",
                required: false,
                attributes: {
                  options: popup_view_opts.join()
                }
              },
              {
                name: "latitude_field",
                label: "Latitude field",
                type: "String",
                sublabel:
                  "The table need a fields of type 'Float' for latitude.",
                required: true,
                attributes: {
                  options: fields
                    .filter(f => f.type.name === "Float")
                    .map(f => f.name)
                    .join()
                }
              },
              {
                name: "longtitude_field",
                label: "Longtitude field",
                type: "String",
                sublabel:
                  "The table need a fields of type 'Float' for longtitude.",
                required: true,
                attributes: {
                  options: fields
                    .filter(f => f.type.name === "Float")
                    .map(f => f.name)
                    .join()
                }
              },
              {
                name: "height",
                label: "Height in px",
                type: "Integer",
                required: true,
                default: 300
              },
              ,
              {
                name: "popup_width",
                label: "Popup width in px",
                type: "Integer",
                required: true,
                default: 300
              }
            ]
          });
        }
      }
    ]
  });

const get_state_fields = async table_id => {
  const table_fields = await Field.find({ table_id });
  return table_fields.map(f => {
    const sf = new Field(f);
    sf.required = false;
    return sf;
  });
};
const mkMap = (points, id) => {
  const iniloc = JSON.stringify(points[0][0]);
  return `var points = ${JSON.stringify(points)};
var map = L.map('${id}').setView(${iniloc}, 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);
map.fitBounds(points.map(pt=>pt[0]));`;
};

const run = async (
  table_id,
  viewname,
  { popup_view, latitude_field, longtitude_field, height, popup_width },
  state,
  extraArgs
) => {
  const id = `map${Math.round(Math.random() * 100000)}`;
  if (popup_view) {
    const popview = await View.findOne({ name: popup_view });
    if (!popview)
      return div(
        { class: "alert alert-danger" },
        "Leaflet map incorrectly configured. Cannot find view: ",
        popup_view
      );

    const popresps = await popview.runMany(state, extraArgs);

    if (popresps.length === 0) return div("No locations");

    const the_data = popresps.map(({ html, row }) => [
      [row[latitude_field], row[longtitude_field]],
      html
    ]);
    return (
      div({ id, style: `height:${height}px;` }) +
      script(
        domReady(`
${mkMap(the_data, id)}
points.forEach(pt=>{
  L.marker(pt[0]).addTo(map)
    .bindPopup(pt[1], {maxWidth: ${popup_width + 5}, minWidth: ${popup_width -
          5}});
});

`)
      )
    );
  } else {
    const tbl = await Table.findOne({ id: table_id });
    const fields = await tbl.getFields();
    const qstate = await stateFieldsToWhere({ fields, state });
    const rows = await tbl.getRows(qstate);
    if (rows.length === 0) return div("No locations");

    const points = rows.map(row => [
      [row[latitude_field], row[longtitude_field]]
    ]);
    return (
      div({ id, style: `height:${height}px;` }) +
      script(
        domReady(`
${mkMap(points, id)}
points.forEach(pt=>{
  L.marker(pt[0]).addTo(map);
});
`)
      )
    );
  }
};
module.exports = {
  sc_plugin_api_version: 1,
  headers,
  viewtemplates: [
    {
      name: "Leaflet map",
      display_state_form: false,
      get_state_fields,
      configuration_workflow,
      run
    }
  ]
};
