import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";

export function registerWidgetResource(server, configuration) {
  const resourceName = configuration.name;
  const resourceUri = configuration.uri;
  const resourceTitle = configuration.title;
  const resourceDescription = configuration.description;
  const prefersBorder = configuration.prefersBorder ?? false;
  const connectDomains = configuration.connectDomains ?? [];
  const resourceDomains = configuration.resourceDomains ?? [];
  const frameDomains = configuration.frameDomains ?? [];
  const uiCsp = { connectDomains, resourceDomains };
  if (frameDomains.length > 0) uiCsp.frameDomains = frameDomains;
  const metadata = {
    ui: { prefersBorder, csp: uiCsp },
    "openai/widgetDescription": resourceDescription,
    "openai/widgetPrefersBorder": prefersBorder,
    "openai/widgetCSP": {
      connect_domains: connectDomains,
      resource_domains: resourceDomains,
      ...(frameDomains.length > 0 ? { frame_domains: frameDomains } : {}),
    },
  };
  const resolveDocument = typeof configuration.html === "function"
    ? configuration.html
    : async () => configuration.html;
  registerAppResource(server, resourceName, resourceUri, {
    title: resourceTitle,
    description: resourceDescription,
    _meta: metadata,
  }, async () => ({
    contents: [{
      uri: resourceUri,
      mimeType: RESOURCE_MIME_TYPE,
      text: await resolveDocument(),
      _meta: metadata,
    }],
  }));
}
