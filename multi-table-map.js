const {
  input,
  div,
  text,
  script,
  domReady,
  style,
} = require("@saltcorn/markup/tags");
const View = require("@saltcorn/data/models/view");
const Workflow = require("@saltcorn/data/models/workflow");
const Table = require("@saltcorn/data/models/table");
const Form = require("@saltcorn/data/models/form");
const Field = require("@saltcorn/data/models/field");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");

const { stateFieldsToWhere } = require("@saltcorn/data/plugin-helper");

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "views",
        form: async (context) => {
          const tables = await Table.find({});
          const lat_long_options = {};
          const popview_options = {};
          for (const table of tables) {
            const fields = await table.getFields();
            lat_long_options[table.name] = fields
              .filter((f) => f.type.name === "Float")
              .map((f) => f.name);
            const popup_views = await View.find_table_views_where(
              table.id,
              ({ viewtemplate, viewrow }) => viewtemplate.runMany
            );
            popup_views.unshift({name: ""});
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
                    attributes: {
                      options: tables.map((t) => t.name),
                    },
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
                    name: "latitude_field",
                    label: "Latitude field",
                    type: "String",
                    sublabel:
                      "The table need a fields of type 'Float' for latitude.",
                    required: true,
                    attributes: {
                      calcOptions: ["table_name", lat_long_options],
                    },
                  },
                  {
                    name: "longtitude_field",
                    label: "Longtitude field",
                    type: "String",
                    sublabel:
                      "The table need a fields of type 'Float' for longtitude.",
                    required: true,
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

const get_state_fields = async () => {
  return [];
};

const mkPoints = (points0) => {
  const points = points0.filter(
    (p) => typeof p[0][0] === "number" && typeof p[0][1] === "number"
  );
  const npts = points.length;
  const iniloc =
    npts > 0
      ? JSON.stringify(points[0][0])
      : [51.5651283, -0.14468174585635246];
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
  { map_tables, popup_width, height },
  state,
  extraArgs,
  queriesObj
) => {
  const id = `map${Math.round(Math.random() * 100000)}`;
  const points = [];
  for (const {
    table_name,
    popup_view,
    latitude_field,
    longtitude_field,
  } of map_tables) {
    if (popup_view) {
      const popview = await View.findOne({ name: popup_view });
      if (!popview)
        return div(
          { class: "alert alert-danger" },
          "Leaflet map incorrectly configured. Cannot find view: ",
          popup_view
        );
      const extraArg = { ...extraArgs };

      const popresps = await popview.runMany(state, extraArg);

      points.push(
        ...popresps.map(({ html, row }) => [
          [row[latitude_field], row[longtitude_field]],
          html,
        ])
      );
    } else {
      const rows = queriesObj?.get_rows_query
        ? await queriesObj.get_rows_query(state, table_name)
        : await getRowsQueryImpl(state, table_name);
      points.push(
        ...rows.map((row) => [[row[latitude_field], row[longtitude_field]]])
      );
    }
  }
  if (points.length === 0) return div("No locations");
  return (
    div({ id, style: `height:${height}px;` }) +
    script(
      domReady(`
        var map = L.map('${id}');
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map);
        var points = ${JSON.stringify(points)}
        points.forEach(pt=>{
          const marker = L.marker(pt[0]).addTo(map);
          if(pt[1])
            marker.bindPopup(pt[1], {maxWidth: ${popup_width + 5}, minWidth: ${
        popup_width - 5
      }});
        });
        map.fitBounds(points.map(pt=>pt[0]));`)
    )
  );
};

const getRowsQueryImpl = async (state, table_name) => {
  const tbl = await Table.findOne(table_name);
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
