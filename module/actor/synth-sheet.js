import { yze } from '../YZEDiceRoller.js';
import { toNumber } from '../utils.js';
import { ALIENRPG } from '../config.js';

/**
 * Extend the basic ActorSheet with some very simple modifications
 * @extends {ActorSheet}
 */
export class alienrpgSynthActorSheet extends ActorSheet {
  constructor(...args) {
    super(...args);

    /**
     * Track the set of item filters which are applied
     * @type {Set}
     */
    this._filters = {
      inventory: new Set(),
    };
  }

  /** @override */
  static get defaultOptions() {
    return mergeObject(super.defaultOptions, {
      classes: ['alienrpg', 'sheet', 'actor', 'synth-sheet'],
      // template: 'systems/alienrpg/templates/actor/actor-sheet.html',
      width: 800,
      height: 900,
      tabs: [{ navSelector: '.sheet-tabs', contentSelector: '.sheet-body', initial: 'general' }],
    });
  }

  get template() {
    const path = 'systems/alienrpg/templates/actor/';
    return `${path}synth-sheet.html`;
  }

  /* -------------------------------------------- */

  /** @override */
  async getData() {
    // Basic data
    let isOwner = this.document.isOwner;
    const data = {
      owner: this.document.isOwner,
      limited: this.document.limited,
      options: this.options,
      editable: this.isEditable,
      cssClass: isOwner ? 'editable' : 'locked',
      isCharacter: this.document.data.type === 'character',
      isSynthetic: this.document.data.type === 'synthetic',
      isEnc: this.document.data.type === 'character' || this.document.data.type === 'synthetic',
      isVehicles: this.document.data.type === 'vehicles',
      isCreature: this.document.data.type === 'creature',
      isNPC: this.document.data.data.header.npc,
      isGM: game.user.isGM,
      config: CONFIG.ALIENRPG,
    };

    // The Actor and its Items
    data.actor = foundry.utils.deepClone(this.actor.data);

    data.items = this.actor.items.map((i) => {
      i.data.labels = i.labels;
      return i.data;
    });
    data.items.sort((a, b) => (a.sort || 0) - (b.sort || 0));
    data.data = data.actor.data;
    data.labels = this.actor.labels || {};
    data.filters = this._filters;

    data.actor.data.general.radiation.icon = this._getClickIcon(data.actor.data.general.radiation.value, 'radiation');
    data.actor.data.general.xp.icon = this._getClickIcon(data.actor.data.general.xp.value, 'xp');
    data.actor.data.general.sp.icon = this._getClickIcon(data.actor.data.general.sp.value, 'sp');

    // Prepare items.
    await this._prepareItems(data); // Return data to the sheet

    // Return data to the sheet
    return data;
  }

  _findActiveList() {
    return this.element.find('.tab.active .directory-list');
  }

  /*
   * Organize and classify Owned Items for Character sheets
   * @private
   */
  async _prepareItems(data) {
    // Initialize containers.
    const inventory = {
      weapon: { section: 'Weapons', label: game.i18n.localize('ALIENRPG.InventoryWeaponsHeader'), items: [], dataset: { type: 'weapon' } },
      item: { section: 'Items', label: game.i18n.localize('ALIENRPG.InventoryItemsHeader'), items: [], dataset: { type: 'item' } },
      armor: { section: 'Armor', label: game.i18n.localize('ALIENRPG.InventoryArmorHeader'), items: [], dataset: { type: 'armor' } },
    };
    // Partition items by category
    let [items, spells, feats, classes, talent] = data.items.reduce(
      (arr, item) => {
        // Item details
        item.img = item.img || DEFAULT_TOKEN;
        item.isStack = item.data.quantity ? item.data.quantity > 1 : false;

        // Classify items into types
        // console.log('alienrpgActorSheet -> _prepareItems -> item', item);
        // if (item.type === 'talent') arr[1].push(item);
        // else if (item.type === 'feat') arr[2].push(item);
        // else if (item.type === 'feature') arr[3].push(item);
        if (Object.keys(inventory).includes(item.type)) arr[0].push(item);
        return arr;
      },
      [[], [], [], []]
    );

    // Apply active item filters
    items = this._filterItems(items, this._filters.inventory);
    const talents = [];
    const agendas = [];
    const specialities = [];
    const critInj = [];
    let totalWeight = 0;

    // Iterate through items, allocating to containers
    for (let i of data.items) {
      let item = i.data;
      switch (i.type) {
        case 'talent':
          talents.push(i);
          break;

        case 'agenda':
          agendas.push(i);
          break;

        case 'specialty':
          specialities.push(i);
          break;
        case 'critical-injury':
          critInj.push(i);
          break;

        case 'armor':
          i.data.attributes.weight.value = i.data.attributes.weight.value || 0;
          i.totalWeight = i.data.attributes.weight.value;
          totalWeight += i.totalWeight;
          inventory[i.type].items.push(i);
          break;

        case 'weapon':
          if (item.header.active != 'fLocker') {
            let ammoweight = 0.25;
            if (i.data.attributes.class.value == 'RPG' || i.name.includes(' RPG ') || i.name.startsWith('RPG') || i.name.endsWith('RPG')) {
              ammoweight = 0.5;
            }
            i.data.attributes.weight.value = i.data.attributes.weight.value || 0;
            i.totalWeight = (i.data.attributes.weight.value + i.data.attributes.rounds.value * ammoweight) * i.data.attributes.quantity.value;
            totalWeight += i.totalWeight;
          }
          inventory[i.type].items.push(i);

          break;

        default:
          if (item.header.active != 'fLocker') {
            i.data.attributes.weight.value = i.data.attributes.weight.value || 0;
            i.totalWeight = i.data.attributes.weight.value * i.data.attributes.quantity.value;
            totalWeight += i.totalWeight;
          }
          inventory[i.type].items.push(i);
          break;
      }
    }
    // Assign and return
    data.talents = talents;
    data.agendas = agendas;
    data.specialities = specialities;
    data.critInj = critInj;
    data.data.general.encumbrance = await this._computeEncumbrance(totalWeight, data);
    data.inventory = Object.values(inventory);
  }

  /*
   * Compute the level and percentage of encumbrance for an Actor.
   *
   * Optionally include the weight of carried currency across all denominations by applying the standard rule
   * from the PHB pg. 143
   *
   * @param {Number} totalWeight    The cumulative item weight from inventory items
   * @param {Object} actorData      The data object for the Actor being rendered
   * @return {Object}               An object describing the character's encumbrance level
   * @private
   */
  async _computeEncumbrance(totalWeight, actorData) {
    // Compute Encumbrance percentage
    const enc = {
      max: actorData.data.attributes.str.value * 4,
      value: Math.round(totalWeight * 100) / 100,
    };
    enc.pct = Math.min((enc.value * 100) / enc.max, 99);
    enc.encumbered = enc.pct > 50;
    for (let i of actorData.talents) {
      if (i.name.toUpperCase() === 'PACK MULE') {
        enc.encumbered = enc.pct > 75;
      }
    }

    if (enc.encumbered) {
      await this.actor.addCondition('encumbered');
    } else {
      await this.actor.removeCondition('encumbered');
    }

    return enc;
  }

  /**
   * Determine whether an Owned Item will be shown based on the current set of filters
   * @return {boolean}
   * @private
   */
  _filterItems(items, filters) {
    return items.filter((item) => {
      const data = item.data;

      return true;
    });
  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);
    // Everything below here is only needed if the sheet is editable
    if (!this.options.editable) return;
    const itemContextMenu = [
      {
        name: game.i18n.localize('ALIENRPG.addToFLocker'),
        icon: '<i class="fas fa-archive"></i>',
        callback: (element) => {
          let item = this.actor.items.get(element.data('item-id'));
          item.update({ 'data.header.active': 'fLocker' });
        },
      },
      {
        name: game.i18n.localize('ALIENRPG.moveFromFlocker'),
        icon: '<i class="fas fa-archive"></i>',
        callback: (element) => {
          let item = this.actor.items.get(element.data('item-id'));
          item.update({ 'data.header.active': false });
        },
      },
      {
        name: game.i18n.localize('ALIENRPG.EditItemTitle'),
        icon: '<i class="fas fa-edit"></i>',
        callback: (element) => {
          const item = this.actor.items.get(element.data('item-id'));
          item.sheet.render(true);
        },
      },
      {
        name: game.i18n.localize('ALIENRPG.DeleteItem'),
        icon: '<i class="fas fa-trash"></i>',
        callback: (element) => {
          let itemDel = this.actor.items.get(element.data('item-id'));
          itemDel.delete();
        },
      },
    ];

    // Add Inventory Item
    new ContextMenu(html, '.item-edit', itemContextMenu);

    const itemContextMenu1 = [
      {
        name: game.i18n.localize('ALIENRPG.EditItemTitle'),
        icon: '<i class="fas fa-edit"></i>',
        callback: (element) => {
          const item = this.actor.items.get(element.data('item-id'));
          item.sheet.render(true);
        },
      },
      {
        name: game.i18n.localize('ALIENRPG.DeleteItem'),
        icon: '<i class="fas fa-trash"></i>',
        callback: (element) => {
          let itemDel = this.actor.items.get(element.data('item-id'));
          itemDel.delete();
        },
      },
    ];

    // Add Inventory Item
    new ContextMenu(html, '.item-edit1', itemContextMenu1);

    // Update Inventory Item
    html.find('.item-edit').click((ev) => {
      const li = $(ev.currentTarget).parents('.item');
      const item = this.actor.items.get(li.data('itemId'));
      item.sheet.render(true);
    });

    if (game.settings.get('alienrpg', 'switchMouseKeys')) {
      // Right to Roll and left to mod
      // Rollable abilities.
      html.find('.rollable').contextmenu(this._onRoll.bind(this));

      html.find('.rollable').click(this._onRollMod.bind(this));

      // Rollable Items.
      html.find('.rollItem').contextmenu(this._rollItem.bind(this));

      html.find('.rollItem').click(this._onRollItemMod.bind(this));
    } else {
      // Left to Roll and Right toMod
      // Rollable abilities.
      html.find('.rollable').click(this._onRoll.bind(this));

      html.find('.rollable').contextmenu(this._onRollMod.bind(this));

      html.find('.currency').on('change', this._currencyField.bind(this));

      // Rollable Items.
      html.find('.rollItem').click(this._rollItem.bind(this));

      html.find('.rollItem').contextmenu(this._onRollItemMod.bind(this));
    }

    // minus from health and stress
    html.find('.minus-btn').click(this._plusMinusButton.bind(this));

    // plus tohealth and stress
    html.find('.plus-btn').click(this._plusMinusButton.bind(this));

    html.find('.click-stat-level').on('click contextmenu', this._onClickStatLevel.bind(this)); // Toggle for radio buttons
    html.find('.click-stat-level-con').on('click contextmenu', this._onClickStatLevelCon.bind(this)); // Toggle for radio buttons

    html.find('.supply-btn').click(this._supplyRoll.bind(this));

    html.find('.pwr-btn').click(this._supplyRoll.bind(this));

    html.find('.stunt-btn').click(this._stuntBtn.bind(this));

    html.find('.talent-btn').click(this._talentBtn.bind(this));

    html.find('.inline-edit').change(this._inlineedit.bind(this));

    html.find('.rollCrit').click(this._rollCrit.bind(this));
    html.find('.rollCrit').contextmenu(this._rollCritMan.bind(this));

    html.find('.activate').click(this._activate.bind(this));
    html.find('.activate').contextmenu(this._deactivate.bind(this));
    html.find('.overwatch-toggle').click(this._onOverwatchToggle.bind(this));

    // Drag events for macros.
    if (this.actor.isOwner) {
      let handler = (ev) => this._onDragStart(ev);
      // Find all items on the character sheet.
      html.find('li.item').each((i, li) => {
        // Ignore for the header row.
        if (li.classList.contains('item-header')) return;
        // Add draggable attribute and dragstart listener.
        li.setAttribute('draggable', true);
        li.addEventListener('dragstart', handler, false);
      });
    }
  }

  /** @override */
  async _onDropItemCreate(itemData) {
    const type = itemData.type;
    const alwaysAllowedItems = ALIENRPG.physicalItems;
    const allowedItems = {
      character: ['item', 'weapon', 'armor', 'talent', 'agenda', 'specialty', 'critical-injury'],
      synthetic: ['item', 'weapon', 'armor', 'talent', 'agenda', 'specialty', 'critical-injury'],
      vehicles: ['item', 'weapon', 'armor'],
      territory: ['planet-system'],
    };
    let allowed = true;

    if (this.actor.type === 'creature') {
      allowed = false;
    } else if (!alwaysAllowedItems.includes(type)) {
      if (!allowedItems[this.actor.type].includes(type)) {
        allowed = false;
      }
    }

    if (!allowed) {
      const msg = game.i18n.format('ALIENRPG.NotifWrongItemType', {
        type: type,
        actor: this.actor.type,
      });
      console.warn(`Alien RPG | ${msg}`);
      ui.notifications.warn(msg);
      return false;
    }
    return super._onDropItemCreate(itemData);
  }

  /* -------------------------------------------- */

  _inlineedit(event) {
    event.preventDefault();
    const dataset = event.currentTarget;
    let itemId = dataset.parentElement.dataset.itemId;
    let item = this.actor.items.get(itemId);
    let temp = dataset.dataset.mod;
    return item.update({ [temp]: dataset.value }, {});
  }

  /**
   * Handle clickable rolls.
   * @param {Event} event   The originating click event
   * @private
   */
  _onRoll(event) {
    event.preventDefault();
    const dataset = event.currentTarget.dataset;
    this.actor.rollAbility(this.actor, dataset);
  }

  _onRollMod(event) {
    event.preventDefault();
    const element = event.currentTarget;
    const dataset = element.dataset;
    this.actor.rollAbilityMod(this.actor, dataset);
  }
  _rollCrit(event) {
    event.preventDefault();
    const dataset = event.currentTarget.dataset;
    this.actor.rollCrit(this.actor.data.type, dataset);
  }

  _rollCritMan(event) {
    event.preventDefault();
    const dataset = event.currentTarget.dataset;
    this.actor.rollCritMan(this.actor, this.actor.data.type, dataset);
  }

  _onRollItemMod(event) {
    event.preventDefault();
    const itemId = $(event.currentTarget).parents('.item').attr('data-item-id');
    const item = this.actor.items.get(itemId);
    this.actor.rollItemMod(item);
  }
  _rollItem(event) {
    event.preventDefault();
    const itemId = $(event.currentTarget).parents('.item').attr('data-item-id');
    const item = this.actor.items.get(itemId);
    this.actor.nowRollItem(item);
  }

  _activate(event) {
    event.preventDefault();
    const dataset = event.currentTarget;
    let itemId = dataset.parentElement.dataset.itemId;
    let item = this.actor.items.get(itemId);

    return item.update({ 'data.header.active': true }, {});
  }
  _deactivate(event) {
    event.preventDefault();
    const dataset = event.currentTarget;
    let itemId = dataset.parentElement.dataset.itemId;
    let item = this.actor.items.get(itemId);

    return item.update({ 'data.header.active': false }, {});
  }

  _plusMinusButton(event) {
    event.preventDefault();
    const element = event.currentTarget;
    const dataset = element.dataset;
    this.actor.stressChange(this.actor, dataset);
  }

  _stuntBtn(event) {
    event.preventDefault();
    let li = $(event.currentTarget).parents('.grid-container');
    let li2 = li.children('#panel');
    let item = '';
    let str = '';
    let chatData = '';
    let temp2 = '';
    let temp3 = '';
    const dataset = event.currentTarget.dataset;
    let langItem = dataset.pmbut;
    let langStr = langItem;

    var newLangStr = langStr.replace(/\s+/g, '');
    let langTemp = 'ALIENRPG.' + [newLangStr];
    temp3 = game.i18n.localize(langTemp);

    try {
      item = game.items.getName(dataset.pmbut);
      str = item.name;
      temp2 = item.data.data.description;
      if (temp2 != null || temp2.length) {
        chatData = item.data.data.description;
      }
      if (temp3.startsWith('<ol>') && chatData.startsWith('<h2>No Stunts Entered</h2>')) {
        chatData = temp3;
      }
    } catch {
      if (temp3.startsWith('<ol>')) {
        chatData = temp3;
      } else {
        chatData = '<h2>No Stunts Entered</h2>';
      }
    }

    let div = $(`<div class="panel Col3">${chatData}</div>`);
    // Toggle summary
    if (li2.hasClass('expanded')) {
      let summary = li2.children('.panel');
      summary.slideUp(200, () => summary.remove());
    } else {
      li2.append(div.hide());
      div.slideDown(200);
    }
    li2.toggleClass('expanded');
  }

  _talentBtn(event) {
    event.preventDefault();
    let li = $(event.currentTarget).parents('.grid-container');
    let li2 = li.children('#panel');
    let item = '';
    let str = '';
    let temp1 = '';
    let temp2 = '';
    let temp3 = '';
    let chatData = '';
    const dataset = event.currentTarget.dataset;

    item = this.actor.items.get(dataset.pmbut);
    str = item.name;
    temp2 = item.data.data.general.comment.value;
    if (temp2 != null && temp2.length > 0) {
      chatData = item.data.data.general.comment.value;
    } else {
      // item = dataset.pmbut;
      // str = item;
      var newStr = str.replace(/\s+/g, '');
      temp1 = 'ALIENRPG.' + [newStr];
      temp3 = game.i18n.localize(temp1);
      if (temp3.startsWith('<p>')) {
        chatData = temp3;
      } else {
        chatData = '<p style="font-size: xx-large;">👾</p>';
      }
    }

    // let chatData = item.data.data.general.comment.value;
    let div = $(`<div class="panel Col3">${chatData}</div>`);

    // Toggle summary
    if (li2.hasClass('expanded')) {
      let summary = li2.children('.panel');
      summary.slideUp(200, () => summary.remove());
    } else {
      li2.append(div.hide());
      div.slideDown(200);
    }
    li2.toggleClass('expanded');
  }

  _onClickStatLevel(event) {
    event.preventDefault();
    this.actor.checkMarks(this.actor, event);
    this._onSubmit(event);
  }

  _onClickStatLevelCon(event) {
    event.preventDefault();
    this.actor.conCheckMarks(this.actor, event);
    this._onSubmit(event);
  }

  /**
   * Get the font-awesome icon used to display a certain level of radiation
   * @private
   */

  _getClickIcon(level, stat) {
    const maxPoints = this.object.data.data.general[stat].max;
    const icons = {};
    const usedPoint = '<i class="far fa-dot-circle"></i>';
    const unUsedPoint = '<i class="far fa-circle"></i>';

    for (let i = 0; i <= maxPoints; i++) {
      let iconHtml = '';

      for (let iconColumn = 1; iconColumn <= maxPoints; iconColumn++) {
        iconHtml += iconColumn <= i ? usedPoint : unUsedPoint;
      }

      icons[i] = iconHtml;
    }

    return icons[level];
  }
  _getContitionIcon(level, stat) {
    const maxPoints = this.object.data.data.general[stat].max;
    const icons = {};
    const usedPoint = '<i class="far fa-dot-circle"></i>';
    const unUsedPoint = '<i class="far fa-circle"></i>';

    for (let i = 0; i <= maxPoints; i++) {
      let iconHtml = '';

      for (let iconColumn = 1; iconColumn <= maxPoints; iconColumn++) {
        iconHtml += iconColumn <= i ? usedPoint : unUsedPoint;
      }

      icons[i] = iconHtml;
    }

    return icons[level];
  }

  _supplyRoll(event) {
    event.preventDefault();
    const element = event.currentTarget;
    const dataset = element.dataset;
    // If it's a power roll it will have an item number so test if it's zero
    if (dataset.item === '0') return;
    const lTemp = 'ALIENRPG.' + dataset.spbutt;
    // If this is a power roll get the exact id of the item to process
    const tItem = dataset.id || 0;
    const label = game.i18n.localize(lTemp) + ' ' + game.i18n.localize('ALIENRPG.Supply');
    const consUme = dataset.spbutt.toLowerCase();
    this.actor.consumablesCheck(this.actor, consUme, label, tItem);
  }

  _currencyField(event) {
    event.preventDefault();
    const element = event.currentTarget;
    // format initial value
    onBlur({ target: event.currentTarget });

    function localStringToNumber(s) {
      return Number(String(s).replace(/[^0-9.-]+/g, ''));
    }
    function onBlur(e) {
      let value = localStringToNumber(e.target.value);
      e.target.value = value ? Intl.NumberFormat('en-EN', { style: 'currency', currency: 'USD' }).format(value) : '';
      // console.warn(e.target.value);
    }
  }
  async _onOverwatchToggle(event) {
    let key = $(event.currentTarget).parents('.condition').attr('data-key');
    if (await this.actor.hasCondition(key)) await this.actor.removeCondition(key);
    else await this.actor.addCondition(key);
  }
}
export default alienrpgSynthActorSheet;
