import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const content = fs.readFileSync(new URL('../content-amazon.js',import.meta.url),'utf8');
const start = content.indexOf('  function amazonShipmentCompositionReasons(');
const end = content.indexOf('  async function parseAmazonOrders(',start);
assert.ok(start>0 && end>start);
const caller = content.slice(start,end);
const quantity = content.slice(content.indexOf('  function extractQuantityFromDOM('),content.indexOf('  function extractASINFromLink('));
const fourItemFixture = process.env.PARSER_PRO_FOUR_ITEM_FIXTURE
  || new URL('./fixtures/amazon-one-shipment-four-items.html',import.meta.url);
const order = '114-4364449-9800232';
const track = `/progress-tracker/package/ref=ppx_yo_dt_b_track_package?itemId=dollone&orderId=${order}&shipmentId=SHP1`;
function model() {
  const link = href => ({href,getAttribute:key=>key==='href'?href:null});
  const products = ['B0DOLLAA01','B0DOLLAA02','B0DOLLAA03','B0DOLLAA04'].map(asin=>link(`/dp/${asin}/ref=ppx_yo_dt_b_asin_image`));
  const button=link(track);
  const box={products,buttons:[button],contains:node=>node===button||products.includes(node),querySelectorAll:()=>box.buttons};
  const card={contains:node=>node===box};
  const context={URL,location:{href:'https://www.amazon.com/gp/css/order-history'},
    SHIPMENT:{TRACK_BUTTON_SELECTOR:'track',collectShipmentProducts:box=>box.products}};
  vm.createContext(context);vm.runInContext(caller,context);
  const check=(overrides={})=>Array.from(context.amazonShipmentCompositionReasons(
    overrides.shipment||{box,isolated:true},overrides.card||card,overrides.button||button,
    overrides.track||track,overrides.order||order,overrides.products||products));
  return {context,check,box,card,button,products,link};
}
test('actual caller accepts opaque itemId with all four shipment products, not token-in-ASIN links',()=>{
  const f=model();assert.deepEqual(f.check(),[]);
  const rows=f.products.map(()=>({qty:'1',track_number:'TBA123456789'}));
  f.context.finalizeAmazonShipmentComposition({parsed:true,reason:'',positions:4},rows);
  assert.ok(rows.every(row=>row.composition_parsed===true && row.composition_reason===''));
  assert.doesNotMatch(content,/compositionReasons\.push\('itemId-not-in-box'\)/);
  assert.match(content,/const compositionReasons = amazonShipmentCompositionReasons\(/);
  assert.match(content,/finalizeAmazonShipmentComposition\(composition, shipmentOrders\)/);
  assert.match(content,/order\.composition_parsed = false;\s*order\.composition_reason = 'shipment-not-finalized';\s*allOrders\.push\(order\)/);
});
test('foreign box, foreign order URL, replaced shipment URL, outside product and partial set remain unproved',()=>{
  const f=model();
  assert.ok(f.check({card:{contains:()=>false}}).includes('shipment-outside-order'));
  assert.ok(f.check({order:'111-1111111-1111111'}).includes('track-order-context-unproven'));
  assert.ok(f.check({track:track.replace('SHP1','FOREIGN')}).includes('track-order-context-unproven'));
  assert.ok(f.check({products:f.products.slice(0,3)}).includes('shipment-products-incomplete'));
  assert.ok(f.check({products:[...f.products.slice(0,3),f.link('/dp/B0FOREIGN1')]}).includes('shipment-products-incomplete'));
  f.box.buttons.push(f.link(track.replace('SHP1','SHP2')));
  assert.ok(f.check().includes('shipment-track-not-exclusive'));
});
test('duplicate links to the same exact target do not introduce another caller refusal',()=>{
  const f=model();f.box.buttons.push(f.link(track));assert.deepEqual(f.check(),[]);
});
test('all rows retain incomplete flag for ambiguous scope, missing product, unknown qty or inconsistent track',()=>{
  const f=model();
  assert.ok(f.check({shipment:{box:f.box,isolated:false,reason:'scope-multi-track'}}).includes('scope-multi-track'));
  for(const qty of [null,undefined,'',0,'0','bad','1.5',-1]){
    const rows=[{qty:'1',track_number:'TBA123456789'},{qty,track_number:'TBA123456789'}];
    f.context.finalizeAmazonShipmentComposition({parsed:true,reason:'',positions:2},rows);
    assert.ok(rows.every(row=>row.composition_parsed===false && row.composition_reason.includes('empty-qty')));
  }
  for(const [reason,positions,rows] of [
    ['scope-multi-track+d-fallback',1,[{qty:'1',track_number:'TBA123456789'}]],
    ['',2,[{qty:'1',track_number:'TBA123456789'}]],
    ['',2,[{qty:'1',track_number:'TBA123456789'},{qty:'1',track_number:'TBA987654321'}]],
  ]){
    f.context.finalizeAmazonShipmentComposition({parsed:!reason,reason,positions},rows);
    assert.ok(rows.every(row=>row.composition_parsed===false));
  }
});

// Small tree double for the actual quantity helper, not a browser/HTML parser.
// Only the helper's simple selectors are supported; other syntax fails loudly.
function quantityTreeNode(tag,attrs={},ownText='') {
  const node={tag,attrs,ownText,children:[],parentElement:null,
    getAttribute:key=>attrs[key]??null,
    append(...children){for(const child of children){child.parentElement=this;this.children.push(child);}},
    contains(other){return this===other || this.children.some(child=>child.contains(other));},
    matches(selector){return selector.split(',').some(part=>{
      const match=part.trim().match(/^([a-z]+)?((?:\.[\w-]+)*)(?:\[([\w-]+)(?:(\*=|=)"([^"]*)")?\])?$/);
      assert.ok(match,`Unsupported tree-double selector: ${part}`);
      const [,tagName,classes,attribute,operator,value]=match;
      return (!tagName || tagName===this.tag)
        && classes.split('.').filter(Boolean).every(cls=>(this.attrs.class||'').split(' ').includes(cls))
        && (!attribute || (operator==='*='?String(this.attrs[attribute]||'').includes(value)
          :operator==='='?this.attrs[attribute]===value:Object.hasOwn(this.attrs,attribute)));
    });},
    closest(selector){for(let current=this;current;current=current.parentElement)if(current.matches(selector))return current;return null;},
    querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);},
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;},
    get textContent(){return this.ownText+this.children.map(child=>child.textContent).join('');},
  };
  return node;
}
test('actual qty helper in Node VM never takes a sibling badge or text via their common parent',()=>{
  const shipment=quantityTreeNode('div',{class:'delivery-box'});
  const items=Array.from({length:4},(_,index)=>{
    const item=quantityTreeNode('div',{class:'yohtmlc-item'});
    const inner=quantityTreeNode('div',{class:'a-fixed-left-grid-inner'});
    const link=quantityTreeNode('a',{href:`/dp/B0DOLLAA0${index+1}`});
    link.append(quantityTreeNode('img',{alt:'Doll'}));inner.append(link);item.append(inner);shipment.append(item);
    return {item,inner};
  });
  const context={console:{log(){}},NodeFilter:{SHOW_TEXT:4},document:{createTreeWalker(root){
    const texts=[];const collect=node=>{if(node.ownText)texts.push({textContent:node.ownText});node.children.forEach(collect);};
    collect(root);return {nextNode:()=>texts.shift()||null};
  }}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL('../shipment-scope.js',import.meta.url),'utf8'),context);
  vm.runInContext(`const SHIPMENT=globalThis.PPShipmentScope;\n${quantity}`,context);
  const read=()=>items.map(({inner})=>context.extractQuantityFromDOM(inner,shipment,4));
  assert.deepEqual(read(),['1','1','1','1']);
  const badge=quantityTreeNode('span',{class:'product-image__qty'},'2');items[1].inner.append(badge);
  assert.equal(shipment.querySelector('.product-image__qty').textContent,'2');
  assert.deepEqual(read(),['1','2','1','1']);
  badge.ownText='?';assert.deepEqual(read(),['1',null,'1','1']);
  // Exercise the actual image-ancestor TreeWalker without a quantity class.
  badge.attrs.class='';badge.ownText='2';assert.deepEqual(read(),['1','2','1','1']);
});

// Optional DOM integration uses a separate local headless browser with all
// network requests blocked. It never attaches to the operational Chrome.
test('actual four-item HTML fixture through real shipment-scope and caller',{
  skip:!process.env.PARSER_PRO_PLAYWRIGHT_MODULE,
},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.PARSER_PRO_PLAYWRIGHT_MODULE).href);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext();await context.route('**/*',route=>route.abort());
    const page=await context.newPage();
    await page.setContent(fs.readFileSync(fourItemFixture,'utf8'));
    await page.addScriptTag({content:fs.readFileSync(new URL('../shipment-scope.js',import.meta.url),'utf8')});
    await page.addScriptTag({content:`const SHIPMENT=globalThis.PPShipmentScope;\n${caller}\n${quantity}`});
    const actual=await page.evaluate(({order})=>{
      const card=document.querySelector('.order-card'),button=card.querySelector(PPShipmentScope.TRACK_BUTTON_SELECTOR);
      const url=new URL(button.getAttribute('href'),'https://www.amazon.com');
      // Set an absolute href; the fixture itself is an offline about:blank document.
      button.href=url.href;
      const shipment=PPShipmentScope.shipmentScope(button,card),products=PPShipmentScope.collectShipmentProducts(shipment.box);
      const reasons=amazonShipmentCompositionReasons(shipment,card,button,url.href,order,products);
      const rows=products.map(product=>({qty:extractQuantityFromDOM(PPShipmentScope.closestItemScope(product),shipment.box,products.length),track_number:'TBA123456789'}));
      finalizeAmazonShipmentComposition({parsed:!reasons.length,reason:reasons.join('+'),positions:products.length},rows);
      const foreign=amazonShipmentCompositionReasons(shipment,card,button,url.href.replace('SHP1','SHP2'),order,products);
      const unknownQty=extractQuantityFromDOM(document.createElement('section'),null,0);
      const readQty=()=>products.map(product=>extractQuantityFromDOM(PPShipmentScope.closestItemScope(product),shipment.box,products.length));
      const badge=document.createElement('span');badge.className='product-image__qty';badge.textContent='2';
      products[1].closest('.yohtmlc-item').append(badge);
      const siblingBadgeQuantities=readQty();
      badge.textContent='?';const unknownBadgeQuantities=readQty();
      const unknownRows=unknownBadgeQuantities.map(qty=>({qty,track_number:'TBA123456789'}));
      finalizeAmazonShipmentComposition({parsed:true,reason:'',positions:4},unknownRows);
      badge.remove();
      // The generic image-ancestor TreeWalker must stay inside the same item.
      const plain=document.createElement('span');plain.textContent='2';
      products[1].closest('.yohtmlc-item').append(plain);
      const plainSiblingQuantities=readQty();plain.remove();
      const outerBadge=document.createElement('span');outerBadge.className='product-image__qty';outerBadge.textContent='9';
      shipment.box.append(outerBadge);
      const shipmentBadgeIgnored=readQty();outerBadge.remove();
      const secondBadge=document.createElement('span');secondBadge.className='product-image__qty';secondBadge.textContent='3';
      badge.textContent='2';products[1].closest('.yohtmlc-item').append(badge,secondBadge);
      const conflictingBadges=readQty();badge.remove();secondBadge.remove();
      const foreignProduct=document.createElement('a');foreignProduct.href='https://www.amazon.com/dp/B0FOREIGN1';
      products[0].closest('.yohtmlc-item').append(foreignProduct);
      const mixedItemQty=readQty();foreignProduct.remove();
      for(const product of products.slice(1))product.closest('.yohtmlc-item').remove();
      shipment.box.append(outerBadge);outerBadge.textContent='3';
      const singlePositionFallback=extractQuantityFromDOM(PPShipmentScope.closestItemScope(products[0]),shipment.box,1);
      outerBadge.textContent='?';
      const unknownSinglePosition=extractQuantityFromDOM(PPShipmentScope.closestItemScope(products[0]),shipment.box,1);
      return {positions:products.length,reasons,rows,foreign,unknownQty,siblingBadgeQuantities,
        unknownBadgeQuantities,unknownRows,plainSiblingQuantities,shipmentBadgeIgnored,conflictingBadges,mixedItemQty,
        singlePositionFallback,unknownSinglePosition};
    },{order});
    assert.equal(actual.positions,4);assert.deepEqual(actual.reasons,[]);
    assert.ok(actual.rows.every(row=>row.composition_parsed===true));
    assert.deepEqual(actual.rows.map(row=>row.qty),['1','1','1','1']);assert.equal(actual.unknownQty,null);
    assert.ok(actual.foreign.includes('track-order-context-unproven'));
    assert.deepEqual(actual.siblingBadgeQuantities,['1','2','1','1']);
    assert.deepEqual(actual.unknownBadgeQuantities,['1',null,'1','1']);
    assert.ok(actual.unknownRows.every(row=>row.composition_parsed===false));
    assert.deepEqual(actual.plainSiblingQuantities,['1','2','1','1']);
    assert.deepEqual(actual.shipmentBadgeIgnored,['1','1','1','1']);
    assert.deepEqual(actual.conflictingBadges,['1',null,'1','1']);
    assert.deepEqual(actual.mixedItemQty,[null,'1','1','1']);
    assert.equal(actual.singlePositionFallback,'3');assert.equal(actual.unknownSinglePosition,null);
  }finally{await browser.close();}
});
