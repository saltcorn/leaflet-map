const { div, script, domReady } = require("@saltcorn/markup/tags");
const View = require("@saltcorn/data/models/view");
const Workflow = require("@saltcorn/data/models/workflow");
const Table = require("@saltcorn/data/models/table");
const Form = require("@saltcorn/data/models/form");
const Field = require("@saltcorn/data/models/field");
const { stateFieldsToWhere } = require("@saltcorn/data/plugin-helper");
const { fetchGeoJSON, radiusFilter, bboxFilter } = require("./postgis-utils");

const isNode = typeof window === "undefined";

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "views",
        form: async (context) => {
          const table = await Table.findOne({ id: context.table_id });
          const fields = await table.getFields();

          const popup_views = await View.find_table_views_where(
            context.table_id,
            ({ viewtemplate, viewrow }) =>
              viewtemplate.runMany && viewrow.name !== context.viewname,
          );

          return new Form({
            fields: [
              {
                name: "popup_view",
                label: "Popup view",
                sublabel: "Blank for no popup",
                type: "String",
                required: false,
                attributes: { options: popup_views.map((v) => v.name).join() },
              },
              {
                name: "postgis_geometry_field",
                label: "PostGIS geometry field",
                type: "String",
                sublabel:
                  "Optional: any field containing geometry (PostGIS column or WKT text). Supports Point, LineString, Polygon and Multi variants.",
                required: false,
                attributes: {
                  options: (() => {
                    const geomTypeNames = new Set(["PostGIS Geometry", "PostGIS Geography"]);
                    const geomFields = fields.filter((f) => geomTypeNames.has(f.type?.name));
                    const otherFields = fields.filter((f) => !geomTypeNames.has(f.type?.name));
                    return [
                      ...geomFields.map((f) => ({ label: `${f.name} (${f.type.name})`, name: f.name })),
                      ...otherFields.map((f) => ({ label: f.name, name: f.name })),
                    ];
                  })(),
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
                  options: fields
                    .filter((f) => f.type.name === "Float")
                    .map((f) => f.name)
                    .join(),
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
                  options: fields
                    .filter((f) => f.type.name === "Float")
                    .map((f) => f.name)
                    .join(),
                },
              },
              {
                name: "icon",
                label: "Icon field",
                type: "String",
                sublabel: "File field used as a custom marker icon.",
                required: false,
                attributes: {
                  options: fields
                    .filter(
                      (f) =>
                        f.reftable_name === "_sc_files" || f.type === "File",
                    )
                    .map((f) => f.name)
                    .join(),
                },
              },
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
              {
                name: "rows_per_page",
                label: "Max rows per page",
                type: "Integer",
              },
              {
                name: "enable_radius_filter",
                label: "Enable 'Near me' filter",
                type: "Bool",
                sublabel:
                  "Adds a 'Near me' button that filters markers within a chosen radius of the user's location and zooms the map to that area.",
              },
              {
                name: "default_radius_km",
                label: "Default radius (km)",
                type: "Float",
                sublabel: "Starting radius shown in the Near me input.",
                default: 10,
                showIf: { enable_radius_filter: true },
              },
              {
                name: "enable_viewport_filter",
                label: "Enable zoom toggle",
                type: "Bool",
                sublabel:
                  "Adds 'Zoom out' / 'Zoom to radius' buttons to switch between the circle view and a fitted view of the filtered markers. Only visible while Near me is active.",
                showIf: { enable_radius_filter: true },
              },
            ],
            validator: (values) => {
              if (
                !values.postgis_geometry_field &&
                (!values.latitude_field || !values.longtitude_field)
              )
                return "Either a PostGIS geometry field or both latitude and longitude fields are required.";
            },
          });
        },
      },
      {
        name: "Other Maps",
        onlyWhen: async (context) => {
          const otherMaps = (
            await View.find({ viewtemplate: "Leaflet map" })
          ).filter((view) => view.name !== context.viewname);
          return otherMaps.length > 0;
        },
        form: async (context) => {
          const otherMaps = (
            await View.find({ viewtemplate: "Leaflet map" })
          ).filter((view) => view.name !== context.viewname);
          return new Form({
            fields: otherMaps.map((v) => ({ name: v.name, type: "Bool" })),
            validator: (values) => {
              const tableIds = new Set();
              for (const [name, val] of Object.entries(values)) {
                if (val === true) {
                  const view = View.findOne({ name });
                  if (view) {
                    if (tableIds.has(view.table_id))
                      return `The table of '${view.name}' is already in use.`;
                    else tableIds.add(view.table_id);
                  }
                }
              }
              return values;
            },
          });
        },
      },
    ],
  });

const get_state_fields = async (table_id) => {
  const table_fields = await Field.find({ table_id });
  return [
    { name: "id", type: "Integer", required: false },
    ...table_fields.map((f) => {
      const sf = new Field(f);
      sf.required = false;
      return sf;
    }),
    { name: "_geo_lat", type: "String", required: false },
    { name: "_geo_lng", type: "String", required: false },
    { name: "_geo_radius_km", type: "String", required: false },
    { name: "_bbox", type: "String", required: false },
  ];
};

const mkPoints = async (
  latitudeField,
  longitudeField,
  popupView,
  table_id,
  extraArg,
  state,
  queriesObj,
  rows_per_page,
  icon,
) => {
  if (popupView) {
    const popview = await View.findOne({ name: popupView });
    if (!popview)
      return div(
        { class: "alert alert-danger" },
        "Leaflet map incorrectly configured. Cannot find view: ",
        popupView,
      );
    const popresps = await popview.runMany(state, {
      ...extraArg,
      limit: rows_per_page,
    });
    return popresps.map(({ html, row }) => [
      [row[latitudeField], row[longitudeField]],
      html,
      icon ? row[icon] : undefined,
    ]);
  } else {
    const rows = queriesObj?.get_rows_query
      ? await queriesObj.get_rows_query(state, table_id)
      : await getRowsQueryImpl(
          state,
          table_id,
          null,
          latitudeField,
          longitudeField,
        );
    return rows.map((row) => [
      [row[latitudeField], row[longitudeField], icon ? row[icon] : undefined],
    ]);
  }
};

const mkFeatures = async (
  geomField,
  popupView,
  table_id,
  extraArg,
  state,
  queriesObj,
  rows_per_page,
  icon,
) => {
  const table = await Table.findOne({ id: table_id });
  const pk = table.pk_name || "id";
  let rows = [];
  const htmlByPk = {};

  if (popupView) {
    const popview = await View.findOne({ name: popupView });
    if (!popview) return [];
    const popresps = await popview.runMany(state, {
      ...extraArg,
      limit: rows_per_page,
    });
    rows = popresps.map((p) => p.row);
    for (const { html, row } of popresps) htmlByPk[row[pk]] = html;
  } else {
    rows = queriesObj?.get_rows_query
      ? await queriesObj.get_rows_query(state, table_id)
      : await getRowsQueryImpl(state, table_id, geomField, null, null);
  }

  if (rows.length === 0) return [];

  const geomById = await fetchGeoJSON(
    table,
    geomField,
    rows.map((r) => r[pk]),
  );

  return rows
    .map((row) => {
      const geom = geomById[row[pk]];
      if (!geom) return null;
      return {
        type: "Feature",
        geometry: geom,
        properties: {
          popup: htmlByPk[row[pk]] || null,
          icon: icon ? row[icon] : null,
        },
      };
    })
    .filter(Boolean);
};

const addOtherPoints = async (
  points,
  features,
  otherMaps,
  extraArgs,
  state,
  queriesObj,
) => {
  for (const otherMap of otherMaps) {
    const {
      latitude_field,
      longtitude_field,
      postgis_geometry_field,
      popup_view,
      rows_per_page,
      icon,
    } = otherMap.configuration;
    if (postgis_geometry_field) {
      features.push(
        ...(await mkFeatures(
          postgis_geometry_field,
          popup_view,
          otherMap.table_id,
          { ...extraArgs },
          state,
          queriesObj,
          rows_per_page,
          icon,
        )),
      );
    } else {
      points.push(
        ...(await mkPoints(
          latitude_field,
          longtitude_field,
          popup_view,
          otherMap.table_id,
          { ...extraArgs },
          state,
          queriesObj,
          rows_per_page,
          icon,
        )),
      );
    }
  }
};

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

const mkMap = (points0, id) => {
  const points = points0.filter(
    (p) => typeof p[0][0] === "number" && typeof p[0][1] === "number",
  );
  const iniloc =
    points.length > 0
      ? JSON.stringify(points[0][0])
      : [51.5651283, -0.14468174585635246];
  return `var points = ${JSON.stringify(points)};
var map = L.map('${id}').setView(${iniloc}, 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);
map.fitBounds(points.map(pt=>pt[0]));
let prevVisibility=false;
let observer = new IntersectionObserver(()=>{
  const nowVisibile = $("#${id}").is(":visible")
  if(!prevVisibility && nowVisibile) {
    map.invalidateSize()
  }
  prevVisibility = nowVisibile;
});
observer.observe(document.querySelector("#${id}"))`;
};

const run = async (
  table_id,
  viewname,
  {
    popup_view,
    latitude_field,
    longtitude_field,
    postgis_geometry_field,
    icon,
    height,
    popup_width,
    rows_per_page,
    enable_radius_filter,
    default_radius_km,
    enable_viewport_filter,
    ...rest
  },
  state,
  extraArgs,
  queriesObj,
) => {
  const id = `map${Math.round(Math.random() * 100000)}`;
  const points = [];
  const features = [];

  if (postgis_geometry_field) {
    features.push(
      ...(await mkFeatures(
        postgis_geometry_field,
        popup_view,
        table_id,
        { ...extraArgs },
        state,
        queriesObj,
        rows_per_page,
        icon,
      )),
    );
  } else {
    points.push(
      ...(await mkPoints(
        latitude_field,
        longtitude_field,
        popup_view,
        table_id,
        { ...extraArgs },
        state,
        queriesObj,
        rows_per_page,
        icon,
      )),
    );
  }

  const otherMaps = (await View.find({ viewtemplate: "Leaflet map" })).filter(
    (view) => view.name !== viewname && rest[view.name],
  );
  await addOtherPoints(
    points,
    features,
    otherMaps,
    extraArgs,
    state,
    queriesObj,
  );

  if (points.length === 0 && features.length === 0) return div("No locations");

  const maxW = (popup_width || 300) + 5;
  const minW = (popup_width || 300) - 5;
  const iconJs = (iconVal) =>
    `{icon: L.icon({iconUrl:'/files/serve/${iconVal}',iconSize:[56,60],iconAnchor:[40,59],popupAnchor:[0,0]})}`;

  const activeGeoLat = state._geo_lat ? parseFloat(state._geo_lat) : null;
  const activeGeoLng = state._geo_lng ? parseFloat(state._geo_lng) : null;
  const activeRadius = parseFloat(
    state._geo_radius_km || default_radius_km || 10,
  );
  const hasActiveRadius = activeGeoLat !== null && activeGeoLng !== null;

  let controlsJs = "";

  if (enable_radius_filter) {
    controlsJs += /*js*/ `
var _NearMeCtrl = L.Control.extend({
  onAdd: function(map) {
    var el = L.DomUtil.create('div');
    el.style.cssText='background:white;padding:4px 6px;border-radius:4px;box-shadow:0 1px 5px rgba(0,0,0,0.4);display:flex;align-items:center;gap:4px;';
    var inp = L.DomUtil.create('input','',el);
    inp.type='number'; inp.min=0.1; inp.step=0.1;
    inp.value=${JSON.stringify(hasActiveRadius ? activeRadius : default_radius_km || 10)};
    inp.title='Radius (km)';
    inp.style.cssText='width:52px;font-size:12px;';
    var lbl = L.DomUtil.create('span','',el);
    lbl.textContent='km'; lbl.style.fontSize='12px';
    var btn = L.DomUtil.create('button','',el);
    btn.textContent='\u{1F4CD} Near me';
    btn.style.cssText='font-size:12px;padding:2px 6px;cursor:pointer;white-space:nowrap;';
    L.DomEvent.on(btn,'click',function(e){
      L.DomEvent.stopPropagation(e);
      if(!navigator.geolocation){alert('Geolocation not supported');return;}
      navigator.geolocation.getCurrentPosition(function(pos){
        var p=new URLSearchParams(window.location.search);
        p.set('_geo_lat',pos.coords.latitude);
        p.set('_geo_lng',pos.coords.longitude);
        p.set('_geo_radius_km',inp.value);
        p.delete('_bbox');
        window.location.href=window.location.pathname+'?'+p.toString();
      },function(err){alert('Location error: '+err.message);});
    });
    ${
      hasActiveRadius
        ? /*js*/ `
    var clr = L.DomUtil.create('button','',el);
    clr.textContent='✕'; clr.title='Clear radius filter';
    clr.style.cssText='font-size:12px;padding:2px 5px;cursor:pointer;color:#c00;';
    L.DomEvent.on(clr,'click',function(e){
      L.DomEvent.stopPropagation(e);
      var p=new URLSearchParams(window.location.search);
      p.delete('_geo_lat'); p.delete('_geo_lng'); p.delete('_geo_radius_km');
      window.location.href=window.location.pathname+'?'+p.toString();
    });
    `
        : ""
    }
    L.DomEvent.disableClickPropagation(el);
    return el;
  }
});
new _NearMeCtrl({position:'topleft'}).addTo(map);
${
  hasActiveRadius
    ? `
var _geoCircle=L.circle([${activeGeoLat},${activeGeoLng}],{
  radius:${activeRadius * 1000},color:'#3388ff',fillColor:'#3388ff',
  fillOpacity:0.05,dashArray:'6,6',weight:2
}).addTo(map);
var _origBounds=_bounds.isValid()?_bounds:null;
map.fitBounds(_geoCircle.getBounds());
`
    : ""
}`;
  }

  if (enable_viewport_filter && hasActiveRadius) {
    controlsJs += /*js*/ `
var _ViewportCtrl = L.Control.extend({
  onAdd: function(map) {
    var el = L.DomUtil.create('div');
    el.style.cssText='background:white;padding:4px 6px;border-radius:4px;box-shadow:0 1px 5px rgba(0,0,0,0.4);display:flex;align-items:center;gap:4px;';
    var btn = L.DomUtil.create('button','',el);
    btn.textContent='Zoom out';
    btn.style.cssText='font-size:12px;padding:2px 6px;cursor:pointer;white-space:nowrap;';
    var _atCircle=true;
    L.DomEvent.on(btn,'click',function(e){
      L.DomEvent.stopPropagation(e);
      if(_atCircle){
        if(_origBounds){map.fitBounds(_origBounds);}else{map.fitWorld();}
        btn.textContent='Zoom to radius';
      } else {
        map.fitBounds(_geoCircle.getBounds());
        btn.textContent='Zoom out';
      }
      _atCircle=!_atCircle;
    });
    L.DomEvent.disableClickPropagation(el);
    return el;
  }
});
new _ViewportCtrl({position:'topleft'}).addTo(map);`;
  }

  return (
    div({ id, style: `height:${height}px;` }) +
    script(
      domReady(`
var map = L.map('${id}');
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

var _bounds = L.latLngBounds();

var _points = ${JSON.stringify(points)};
_points.filter(pt=>typeof pt[0][0]==="number").forEach(pt=>{
  L.marker(pt[0], pt[0][2] ? ${iconJs("'+pt[0][2]+'")} : {}).addTo(map)
    .bindPopup(pt[1]||'', {maxWidth:${maxW},minWidth:${minW}})${
      isNode ? "" : mobileImgLoader()
    };
  _bounds.extend([pt[0][0], pt[0][1]]);
});

var _features = ${JSON.stringify(features)};
if (_features.length) {
  var _geojson = L.geoJSON({type:"FeatureCollection",features:_features}, {
    style: {color:"#3388ff", fillColor:"#3388ff", fillOpacity:0.2},
    pointToLayer: function(f, latlng) {
      return f.properties && f.properties.icon
        ? L.marker(latlng, ${iconJs("'+f.properties.icon+'")} )
        : L.marker(latlng);
    },
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
${controlsJs}
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

const renderRows = async (
  _table,
  _viewname,
  { popup_view, latitude_field, longtitude_field, height, popup_width },
  extra,
  rows,
) => {
  if (popup_view) {
    const popview = await View.findOne({ name: popup_view });
    if (!popview)
      return [
        div(
          { class: "alert alert-danger" },
          "Leaflet map incorrectly configured. Cannot find view: ",
          popup_view,
        ),
      ];
    const poptable = await Table.findOne({ id: popview.table_id });
    const rendered = await popview.viewtemplateObj.renderRows(
      poptable,
      popview.name,
      popview.configuration,
      extra,
      rows,
    );
    return rendered.map((html, ix) => {
      const row = rows[ix];
      const the_data = [[[row[latitude_field], row[longtitude_field]], html]];
      const id = `map${Math.round(Math.random() * 100000)}`;
      return (
        div({ id, style: `height:${height}px;` }) +
        script(
          domReady(`
${mkMap(the_data, id)}
points.forEach(pt=>{
  L.marker(pt[0]).addTo(map)
    .bindPopup(pt[1], {maxWidth:${popup_width + 5},minWidth:${popup_width - 5}})
    ${isNode ? "" : mobileImgLoader()};
});
`),
        )
      );
    });
  } else {
    return rows.map((row) => {
      const id = `map${Math.round(Math.random() * 100000)}`;
      return (
        div({ id, style: `height:${height}px;` }) +
        script(
          domReady(`
${mkMap([[[row[latitude_field], row[longtitude_field]]]], id)}
points.forEach(pt=>{ L.marker(pt[0]).addTo(map); });
`),
        )
      );
    });
  }
};

const getRowsQueryImpl = async (
  state,
  table_id,
  geomField,
  latField,
  lngField,
) => {
  const tbl = await Table.findOne({ id: table_id });
  const fields = await tbl.getFields();
  const { _geo_lat, _geo_lng, _geo_radius_km, _bbox, ...regularState } = state;
  const qstate = await stateFieldsToWhere({ fields, state: regularState });
  let rows = await tbl.getRows(qstate);

  if (_geo_lat && _geo_lng) {
    rows = await radiusFilter(
      tbl,
      geomField,
      latField,
      lngField,
      rows,
      parseFloat(_geo_lat),
      parseFloat(_geo_lng),
      parseFloat(_geo_radius_km || 10),
    );
  }
  if (_bbox) {
    const [swLat, swLng, neLat, neLng] = _bbox.split(",").map(Number);
    rows = await bboxFilter(
      tbl,
      geomField,
      latField,
      lngField,
      rows,
      swLat,
      swLng,
      neLat,
      neLng,
    );
  }
  return rows;
};

const connectedObjects = async ({ viewname, popup_view, ...rest } = {}) => {
  let result = { embeddedViews: [], tables: [] };
  if (popup_view) {
    const popupView = View.findOne({ name: popup_view });
    if (popupView) result.embeddedViews.push(popupView);
  }
  const otherMaps = (await View.find({ viewtemplate: "Leaflet map" })).filter(
    (view) => view.name !== viewname && rest[view.name],
  );
  for (const otherMap of otherMaps) {
    if (
      otherMap.configuration?.popup_view &&
      !result.embeddedViews.find(
        (v) => v.name === otherMap.configuration.popup_view,
      )
    ) {
      const otherPopup = View.findOne({
        name: otherMap.configuration.popup_view,
      });
      if (otherPopup) result.embeddedViews.push(otherPopup);
    }
    const otherTable = Table.findOne({ id: otherMap.table_id });
    if (otherTable) result.tables.push(otherTable);
  }
  return result;
};

module.exports = {
  name: "Leaflet map",
  display_state_form: false,
  get_state_fields,
  configuration_workflow,
  run,
  queries: ({ postgis_geometry_field, latitude_field, longtitude_field }) => ({
    async get_rows_query(state, table_id) {
      return await getRowsQueryImpl(
        state,
        table_id,
        postgis_geometry_field,
        latitude_field,
        longtitude_field,
      );
    },
  }),
  renderRows,
  connectedObjects,
};
