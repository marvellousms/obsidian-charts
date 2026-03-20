import { parseYaml, Plugin } from 'obsidian';
import * as d3san from 'd3-sankey';
import * as d3 from 'd3';
import { SankeySettingTab } from 'src/settings';
import { RenderSankey } from './render';


interface SNodeExtra {
    name: string;
    color?: string;
    value?: number;
}

interface SLinkExtra {
    source: string;
    target: string;
    value: number;
}

interface SankeySettings {
    nodeWidth: number;
    linkColor: string; // ['source', 'target', 'none']
    nodeAlign: string; // ['left', 'right', 'center', justify']
    nodePadding: number;
}

const DEFAULT_SETTINGS: Partial<SankeySettings> = {
    nodeWidth: 5,
    linkColor: 'target',
    nodeAlign: 'left',
    nodePadding: 10
};

const nodeAlign: Record<string, (node: d3san.SankeyNode<{}, {}>, n: number) => number> = {
    'left': d3san.sankeyLeft,
    'right': d3san.sankeyRight,
    'center': d3san.sankeyCenter,
    'justify': d3san.sankeyJustify
}

type SNode = d3san.SankeyNode<SNodeExtra, SLinkExtra>;
type SLink = d3san.SankeyLink<SNodeExtra, SLinkExtra>;

interface YamlData {
    links: SLink[];
    nodes: SNode[];
}

interface SankeyData {
    nodes: SNode[];
    links: SLink[];
}

/**
 * Resolves links with value '?' by propagating known values through the graph.
 * A '?' link can be resolved at a node if all other links on one side are known
 * and the opposite side is fully known (conservation of flow).
 * Throws if any '?' values remain unresolvable or if a resolved value is negative.
 */
function resolveUnknownLinks(data: SankeyData): void {
    const unknownLinks = new Set<SLink>();
    for (const link of data.links) {
        if ((link.value as unknown) === '?') {
            unknownLinks.add(link);
            link.value = 0;
        }
    }

    if (unknownLinks.size === 0) return;

    let progress = true;
    while (progress) {
        progress = false;
        for (const node of data.nodes) {
            const inLinks = data.links.filter(l => l.target === node.name);
            const outLinks = data.links.filter(l => l.source === node.name);
            const unknownIn = inLinks.filter(l => unknownLinks.has(l));
            const unknownOut = outLinks.filter(l => unknownLinks.has(l));

            let resolved: number | null = null;
            let resolvedLink: SLink | null = null;

            if (unknownIn.length === 1 && unknownOut.length === 0 && outLinks.length > 0) {
                const knownInSum = inLinks.filter(l => !unknownLinks.has(l)).reduce((s, l) => s + l.value, 0);
                const outSum = outLinks.reduce((s, l) => s + l.value, 0);
                resolved = outSum - knownInSum;
                resolvedLink = unknownIn[0];
            } else if (unknownOut.length === 1 && unknownIn.length === 0 && inLinks.length > 0) {
                const inSum = inLinks.reduce((s, l) => s + l.value, 0);
                const knownOutSum = outLinks.filter(l => !unknownLinks.has(l)).reduce((s, l) => s + l.value, 0);
                resolved = inSum - knownOutSum;
                resolvedLink = unknownOut[0];
            }

            if (resolved !== null && resolvedLink !== null) {
                if (resolved < 0) {
                    throw new Error(`Resolved link value is negative (${resolved}) at node "${node.name}" — check that values are consistent.`);
                }
                resolvedLink.value = resolved;
                unknownLinks.delete(resolvedLink);
                progress = true;
            }
        }
    }

    if (unknownLinks.size > 0) {
        throw new Error(`Cannot resolve ${unknownLinks.size} unknown link value(s): not enough constraints. Each '?' must be the only unknown at one side of a node.`);
    }
}

/**
 * Assigns colors to nodes that don't have one.
 */
function prepareNodes(data: SankeyData): void {
    data.nodes.forEach((node) => {
        verifyColorOrRandom(node);
    });
}

/**
 * Assigns status-based colors to nodes based on their name.
 * @param node Node to color
 * @returns true if a status color was applied, false otherwise
 */
function applyStatusColor(node: SNode): boolean {
    const name = (node.name || '').toLowerCase();
    
    // Status-based color mapping
    if (name.includes('original') || name.includes('start') || name.includes('source')) {
        node.color = '#808080'; // Gray
        return true;
    }
    if (name.includes('pending') || name.includes('waiting') || name.includes('in progress')) {
        node.color = '#ffa500'; // Orange
        return true;
    }
    if (name.includes('rejected') || name.includes('failed') || name.includes('denied')) {
        node.color = '#ff4444'; // Red
        return true;
    }
    if (name.includes('retry') || name.includes('needs retry') || name.includes('error')) {
        node.color = '#ffd700'; // Yellow/Gold
        return true;
    }
    if (name.includes('success') || name.includes('accepted') || name.includes('hired')) {
        node.color = '#44ff44'; // Green
        return true;
    }
    
    return false;
}

/**
 * Checks wheter a string is a valid css color.
 * @param color CSS color string to verify
 * @returns The verified color or a random color
 */
function verifyColorOrRandom(node: SNode): SNode {
    if (node.color) {
        const s = new Option().style;
        s.color = node.color;

        if (s.color !== '') {
            node.color = d3.rgb(node.color).toString();
            return node;
        }
    }

    // Try status-based coloring first
    if (applyStatusColor(node)) {
        return node;
    }

    //No valid color -> Add random color
    let num = Math.round(0xffffff * Math.random());
    let r = num >> 16;
    let g = num >> 8 & 255;
    let b = num & 255;
    node.color = 'rgb(' + r + ', ' + g + ', ' + b + ')';
    return node;
}

function linkColor(link: SLink, linkColor: string): string {
    let color;
    switch (linkColor.toLowerCase()) {
        case 'source':
            color = (link.source as SNode).color!;
            break;

        case 'target':
            color = (link.target as SNode).color!;
            break;

        default:
            color = 'var(--text-muted)';
            break;
    }

    return color;
}

export function createSankey(source: string, settings: SankeySettings): SVGSVGElement {
    const preprocessed = source.replace(/(\bvalue:\s*)\?(\s*(?:#.*)?$)/gm, "$1'?'$2");
    const yamlData = parseYaml(preprocessed) as YamlData;
    const sankeyData = parseSankeyData(yamlData);

    return generateSVG(sankeyData, settings);
}

function parseSankeyData(yamlData: YamlData): SankeyData {
    const sankeyData = { nodes: yamlData.nodes, links: yamlData.links };

    if (sankeyData.nodes == null) {
        sankeyData.nodes = [];
    }

    if (sankeyData.links == null) {
        sankeyData.links = [];
    }

    // Add all nodes to sankeyData
    sankeyData.links.forEach((link) => {
        if (!sankeyData.nodes.some((node) => node.name == link.source)) {
            sankeyData.nodes.push({ name: link.source });
        }
        if (!sankeyData.nodes.some((node) => node.name == link.target)) {
            sankeyData.nodes.push({ name: link.target });
        }
    });

    resolveUnknownLinks(sankeyData);
    prepareNodes(sankeyData);

    return sankeyData;
}

function generateSVG(data: SankeyData, settings: SankeySettings): SVGSVGElement {
    // Calculate width based on number of node columns
    // Find the maximum x-position to determine how many columns we have
    const generator = d3san.sankey()
        .nodes(data.nodes)
        .links(data.links)
        .nodeAlign(nodeAlign[settings.nodeAlign])
        .nodeWidth(settings.nodeWidth)
        .extent([
            [10, 10],
            [
                900,
                580
            ]
        ])
        .nodeId((d) => (d as SNode).name)
        .nodePadding(settings.nodePadding);

    generator(data);

    // Calculate proper dimensions based on layout
    const maxX = Math.max(...data.nodes.map(n => n.x1 || 0));
    const dimensions = {
        height: 600,
        width: Math.max(900, maxX + 200), // Add 200px buffer for text labels
        margins: 10
    }

    // Re-run layout with correct dimensions
    generator
        .extent([
            [dimensions.margins, dimensions.margins],
            [
                dimensions.width - dimensions.margins * 2,
                dimensions.height - dimensions.margins * 2
            ]
        ]);
    
    generator(data);

    //Create SVG with viewBox for proper scaling
    const svg = d3.create('svg')
        .attr("viewBox", `0 0 ${dimensions.width} ${dimensions.height}`)
        .attr("height", dimensions.height)
        .attr("width", "100%")
        .attr("preserveAspectRatio", "xMidYMid meet")
        .attr("overflow", "visible")
        .attr("class", "sankey-diagram")
        .style('background', 'transparent');

    // Add nodes
    svg.append("g")
        .selectAll("rect")
        .data(data.nodes)
        .join("rect")
        .attr("x", (d) => d.x0!)
        .attr("y", (d) => d.y0!)
        .attr("fill", (d) => d.color!)
        .attr("height", (d) => d.y1! - d.y0!)
        .attr("width", (d) => d.x1! - d.x0!);

    // Add links
    svg.append("g")
        .selectAll()
        .data(data.links)
        .join("path")
        .attr("fill", "none")
        .attr("stroke-opacity", 0.3)
        .attr("stroke", (d) => linkColor(d, settings.linkColor))
        .attr("d", d3san.sankeyLinkHorizontal())
        .attr("stroke-width", (d) => d.width!);

    // Add text to nodes
    svg.append("g")
        .selectAll()
        .data(data.nodes)
        .join("text")
        .attr("x", d => d.x0! < dimensions.width / 2 ? d.x1! + 6 : d.x0! - 6)
        .attr("y", d => (d.y1! + d.y0!) / 2)
        .attr("dy", "0.35em")
        .attr("text-anchor", d => d.x0! < dimensions.width / 2 ? "start" : "end")
        .attr("fill", 'var(--text-normal)')
        .style("font-size", "12px")
        .text(d => `${d.name}: ${d.value}`);

    return svg.node()!;
}

export default class SankeyPlugin extends Plugin {
    settings: SankeySettings;

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new SankeySettingTab(this.app, this));

        this.registerMarkdownCodeBlockProcessor('sankey', (source, el, ctx) => {
            ctx.addChild(new RenderSankey(this, el, source));
        });
    }
}
