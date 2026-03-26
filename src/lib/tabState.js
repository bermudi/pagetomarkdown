function getTablists(root) {
    if (!root?.querySelectorAll) return [];
    return Array.from(root.querySelectorAll('[role="tablist"], [data-geist-tabs]'));
}

function getActiveTab(tablist) {
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"], button, [data-geist-tab]'));
    return (
        tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') ||
        tabs.find((tab) => tab.getAttribute('data-state') === 'active') ||
        null
    );
}

function getControlledPanels(tablist, root) {
    const tabs = Array.from(tablist.querySelectorAll('[aria-controls]'));
    const panelEntries = [];

    for (const tab of tabs) {
        const panelId = tab.getAttribute('aria-controls');
        if (!panelId) continue;
        const panel = root.querySelector(`[id="${panelId}"]`);
        if (!panel) continue;
        panelEntries.push({ tab, panel, panelId });
    }

    return panelEntries;
}

function collectPanelNodes(panel) {
    if (!panel) return [];
    const nodes = [panel];

    let next = panel.nextElementSibling;
    while (next && !next.matches('[role="tabpanel"], [id], [data-state]')) {
        if (next.matches('pre, code, div, section, article, p')) {
            nodes.push(next);
            next = next.nextElementSibling;
            continue;
        }
        break;
    }

    return nodes;
}

export function preserveActiveTabs(root) {
    if (!root?.querySelectorAll) return { tablistsProcessed: 0, panelsRemoved: 0 };

    let tablistsProcessed = 0;
    let panelsRemoved = 0;

    for (const tablist of getTablists(root)) {
        const activeTab = getActiveTab(tablist);
        if (!activeTab) continue;

        const panelEntries = getControlledPanels(tablist, root);
        if (panelEntries.length < 2) continue;

        const activePanelId = activeTab.getAttribute('aria-controls');
        if (!activePanelId) continue;

        let removedForTablist = 0;
        for (const entry of panelEntries) {
            if (entry.panelId === activePanelId) continue;

            const panelNodes = collectPanelNodes(entry.panel);
            for (const node of panelNodes) {
                if (!node?.parentNode) continue;
                node.parentNode.removeChild(node);
                removedForTablist += 1;
            }
        }

        if (removedForTablist > 0) {
            tablistsProcessed += 1;
            panelsRemoved += removedForTablist;
        }
    }

    return { tablistsProcessed, panelsRemoved };
}
