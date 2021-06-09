/**
 * This file is part of the Virtual Game Table distribution.
 * Copyright (c) 2015-2021 Jack Childress (Sankey).
 * 
 * This program is free software: you can redistribute it and/or modify  
 * it under the terms of the GNU General Public License as published by  
 * the Free Software Foundation, version 3.
 *
 * This program is distributed in the hope that it will be useful, but 
 * WITHOUT ANY WARRANTY; without even the implied warranty of 
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU 
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License 
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

/* 
METHODOLOGY
1. Whenever certain attributes (e.g. position, image index) of our local Things are updated, 
   the changes are added to (or updated in) an outbound queue.

2. All incoming packets from the server to us are similarly queued into an inbound queue.

3. These queues are dealt with all at once every quarter second or so. 
   First the inbound queue is processed, then outbound is sent to the server.

4. The server adds all such updates to a master list, then relays each incoming queue packet to everyone.
   This includes returning it to the sender, to avoid lag-induced desync; the latest server state is sent to EVERYONE
   as it's updated.

5. Upon receiving updated pieces, clients will NOT update those pieces they are holding, because that's interferes with 
   their local reality (they have control!). The exception to this rule is if someone else says they're holding it.
   If two people grab the same piece, the server enforces that the first one holds it.
   There is a guaranteed update sent when pieces are released, so it cannot get too out of sync.

6. Clients only update each piece attribute if either the sender is NOT us, 
   or if it IS us AND we haven't sent a more recent update. (Each outbound packet also has a packet index (nq) that increments.)

7. On connection, the server sends all the latest information in one big packet, like a big queue update.

IDEAS 

ISSUES

OTHER PARADIGMS & APPROACHES
 * Each client keeps track of what the server has, and loops over everything to send a delta.

NET OPTIMIZATIONS

CURRENTLY
 * Find a JACK comment and fix that too.

*/


// Object for interacting with the html page.
class Html {
  
  constructor() {
    
    // Handles
    this.gameboard = document.getElementById('gameboard');
    this.loader    = document.getElementById('loader');
    this.volume    = document.getElementById('volume');
    this.controls  = document.getElementById('controls');
    this.messages  = document.getElementById('messages');
    this.setups    = document.getElementById('setups');
  
  } // End of constructor

  // Quick functions
  hide_controls() {this.controls.hidden = true;}
  show_controls() {this.controls.hidden = false;}
  toggle_controls() {this.controls.hidden = !this.controls.hidden;}
  controls_visible() {return !this.controls.hidden}
  controls_hidden()  {return  this.controls.hidden}

  /**
   * Updates the chat box with the supplied name and message.
   */
  chat(name, message) {
    // messages div object
    var m = html.messages;

    // append a <li> object to it
    var li = document.createElement("li");
    li.insertAdjacentHTML('beforeend', '<b>' + name + ':</b> ' + message)
    m.append(li);

    // scroll to the bottom of the history
    m.scrollTop = m.scrollHeight;
  }

  // Updates the client information in the GUI
  rebuild_client_table() {
    log('html.rebuild_client_table()');

    // Clear out the clients table
    var clients_table = document.getElementById('clients');
    clients_table.innerHTML = '';

    // Loop over the supplied clients
    for(var id in net.clients) {
      var c = net.clients[id];
      log('  ', c.id, c.name, c.team);

      // Get the "safe" name & team
      var name = html_encode(c.name);
      var team = html_encode(c.team);
      if(id == net.id) {
        save_cookie('name', name);
        save_cookie('team', team);
      }

      // Create the row for this client, as long as it's not me.
      if(id != net.id) var row = clients_table.insertRow(-1);
      else             var row = clients_table.insertRow(0);
      var cell_name = row.insertCell(0);
      var cell_team = row.insertCell(1);

      // If it's net.me, the name should be editable, otherwise, not
      if(id == net.id) cell_name.innerHTML = '<input id="name" onchange="interaction.onchange_name(event)" value="'+name+'" />';
      else             cell_name.innerHTML = '<input class="othername" readonly value="'+name+'" />';

      // Now create the team selector if it's me
      var s = document.createElement("select");
      s.id  = String(id); 
      s.onchange = interaction.onchange_team;

      // Create and append the options
      for (var k in game.settings.teams) {
          var o = document.createElement("option");
          o.value = k;
          o.text  = k;
          s.appendChild(o);
      }

      // Set the team
      s.selectedIndex = team;

      // Finally, append it to the team cell
      cell_team.appendChild(s);
      
    } // End of loop over clients

  } // End of rebuild_client_table()

} // End of Html
html = new Html();




// Netcode
class Net {

  constructor() {

    this.io = io();         // Network object
    this.id = 0;            // My client id.
    this.ready = false;     // Whether we pay attention to the network traffic yet
    this.clients      = {}; // Client objects by client id
    
    this.q_pieces_out = {}; // Queue of outbound information for the next housekeeping.
    this.q_pieces_in  = {}; // Queue of inbound information for the next housekeeping.

    this.q_hands_out  = {}; // Queue of outbound information for the next housekeeping.
    this.q_hands_in   = {}; // Queue of inbound information for the next housekeeping.

    this.nq           = 0;  // Last sent q packet number

    // Defines all the functions for what to do with incoming packets.
    this.setup_listeners();

  } // End of constructor()

  /** Deals with the incoming AND outbound packets. */
  process_queues() {
    if(!this.ready) return;
    var c, p;
    var t = Date.now();
    
    // INBOUND

    // Loop over the pieces in the q
    for(var id in this.q_pieces_in) { 
      c = this.q_pieces_in[id]; // incoming changes for this thing
      p = pieces.all[id];       // the actual piece object

      // JACK: UPDATE THE HOLD STATUS FIRST, in case the server is overriding this.

      // If the piece is valid and we're not holding it, update it.
      if(p && p.id_client_hold != net.id) {

        // Only update each attribute if the sender is NOT us, or if it IS us AND we haven't sent a more recent update already
        if(c.id_client_sender != net.id || c.nq >= p.last_nqs['x']) p.set_xyrs_target(c.x, undefined, undefined, undefined, false, true);
        if(c.id_client_sender != net.id || c.nq >= p.last_nqs['y']) p.set_xyrs_target(undefined, c.y, undefined, undefined, false, true);
        if(c.id_client_sender != net.id || c.nq >= p.last_nqs['r']) p.set_xyrs_target(undefined, undefined, c.r, undefined, false, true);
        if(c.id_client_sender != net.id || c.nq >= p.last_nqs['s']) p.set_xyrs_target(undefined, undefined, undefined, c.s, false, true);
        if(c.id_client_sender != net.id || c.nq >= p.last_nqs['n']) p.set_texture_index(c.n, true);
        if(c.id_client_sender != net.id || c.nq >= p.last_nqs['ts']) p.select(c.ts, true);
        if(c.id_client_sender != net.id || c.nq >= p.last_nqs['ih']) p.hold(c.ih, true);
      }

    }; this.q_pieces_in = {}; // End of loop over q_pieces_in
    

    // Loop over the hands in the input queue
    for(var id in this.q_hands_in) {
      c = this.q_hands_in[id]; // Incoming changes
      p = hands.all[id];       // Actual hand

      // Visually update the object
      if(p){

        // Discard info if it's our hand
        if(p.id_client != net.id) {
          p.set_xyrs_target(c.x, c.y, c.r, c.s, false, true);
          p.set_texture_index(c.n, true);
        }
      }
    
    }; this.q_hands_in = {}; // End of loop over q_hands_in


    // OUTBOUND

    // Send the outbound information
    if(Object.keys(this.q_pieces_out).length 
    || Object.keys(this.q_hands_out ).length) {

      // Send the outbound information and clear it.
      this.nq++;
      log(    'NETS_q', [this.nq, this.q_pieces_out, this.q_hands_out]);
      this.io.emit('q', [this.nq, this.q_pieces_out, this.q_hands_out]);
      this.q_pieces_out = {};
      this.q_hands_out  = {};
    }

  } // End of process_queues()

  // Transfers information from q_source to q_target, with id_client
  transfer_to_q_in(q_source, q_target, id_client, nq) {
    
    // Loop over pieces in source queue
    for(var id in q_source) {
          
      // Make sure the target has a place for the data
      if(!q_target[id]) q_target[id] = {}
        
      // Update each attribute
      for(var k in q_source[id]) q_target[id][k] = q_source[id][k]; 

      // Keep track of who is requesting the change and their q packet number
      q_target[id]['id_client_sender'] = id_client;
      q_target[id]['nq']               = nq;
        
    } // End of loop over things in q_pieces
  }

  /** Define what server messages to expect, and how to handle them. */
  setup_listeners() {
  
    // Main listener for incoming data queue
    this.io.on('q', function(data) { if(!this.ready) return; log('NETR_q_'+String(data[0]), data);
      var id_client = data[0];
      var nq        = data[1];
      var q_pieces  = data[2];
      var q_hands   = data[3];  

      // Update the q's
      this.transfer_to_q_in(q_pieces, this.q_pieces_in, id_client, nq);
      this.transfer_to_q_in(q_hands,  this.q_hands_in,  id_client, nq);
      
    }.bind(this)); // End of on 'q'

    // First thing to come back after 'hallo' is the full game state
    this.io.on('state', function(data) { if(!this.ready) return; log('NETR_state', data);
      
      // Get our client id and the server state
      var id           = data[0];
      var server_state = data[1];
      
      // Store all the info we need to keep locally
      this.clients = server_state.clients;

      // The server assigned net.me a unique id
      this.id = parseInt(id);

      // Send client information to the gui (rebuilds the HTML), and the clients object
      clients.rebuild();

      // Transfer / initialize the input queue, then process it.
      this.q_pieces_in = server_state['pieces'];
      this.q_hands_in  = server_state['hands'];
      this.process_queues();

      // Now show controls
      html.loader.style.visibility  = 'hidden';

      // Say hello
      html.chat('Server', 'Welcome, '+ net.clients[net.id].name + '!')

    }.bind(this));

    this.io.on('clients', function(data) { if(!net.ready) return;
      log('NETR_clients', data);

      // Update the state
      this.clients = data;

      // Rebuild gui and clients list
      clients.rebuild();

    }.bind(this));

    this.io.on('yabooted', function() {
      log('NETR_yabooted');
      document.body.innerHTML = 'Booted. Reload page to rejoin.'
      document.body.style.color = 'white';
    }.bind(this))

    // New game command from server
    this.io.on('new_game', function(server_state) {
      // Bonk out if we're not ready.
      if(!net.ready) return;
      log('NETR_new_game', server_state);

    }.bind(this));

    // Client says something (audio). data = [client_index, path, interrupt_same]
    this.io.on('say', function(data) { if(!net.ready) return;
      log('NETR_say', data);

      // Say it
      clients[data[0]].say(data[1], data[2], data[3]);
    }.bind(this));

    // server sent a "chat"
    this.io.on('chat', function(data) { if(!net.ready) return;
      
      var id = data[0];
      var message = data[1];
      log('NETR_chat', id, message);

      // Safe-ify the name
      message = html_encode(message);
      
      // Get the name
      if(id == 0) var name = 'Server'
      else        var name = this.clients[id].name
      
      // Update the interface
      html.chat(name, message);
      
    }.bind(this));
  
  } // End of setup_listeners()

  /**
   * Connect to the server (don't do this until Pixi is ready)
   */
  connect_to_server() {
    log('connect_to_server()', this);
  
    // Get name to send to server with hallo.
    var name = get_cookie_value('name');
    var team = parseInt(get_cookie_value('team'));
    if(isNaN(team)) team = 0;

    // Ask for the game state.
    log(    'NETS_hallo', [name, team]);
    this.io.emit('hallo', [name, team]);
  
    // Ready to receive packets now!
    net.ready = true; 
  }

} // End of Net
net = new Net()


////////////////////////////////////
// PIXI SETUP                     //
////////////////////////////////////

/**
 * Holds all the pixi stuff.
 */
class Pixi {

  constructor() {

    // Let's the rest of the world know the pixi stage is ready.
    this.ready = false;
    this.queue = [];

    // Create the app instance
    this.app = new PIXI.Application({
      autoResize: true, 
      resolution: devicePixelRatio, 
      antialias: true, 
      transparent: false,
    });

    // Add the canvas that Pixi automatically created for you to the HTML document
    html.gameboard.appendChild(this.app.view);

    // Aliases
    this.loader      = PIXI.Loader.shared,
    this.resources   = PIXI.Loader.shared.resources,
    this.stage       = this.app.stage;
    this.renderer    = this.app.renderer;

    // Set up the renderer
    this.renderer.backgroundColor     = 0x000000;
    this.renderer.autoDensity         = true;
    this.renderer.view.style.position = "absolute";
    this.renderer.view.style.display  = "block";

    // Add the touchable 'surface' with the background color
    this.surface = new PIXI.Graphics().beginFill(0xF4EFEE).drawRect(0, 0, 1, 1);
    this.stage.addChild(this.surface);

    // Set up loading progress indicator, which happens pre PIXI start
    this.loader.onProgress.add(this.loader_onprogress.bind(this));
  
    // Assemble the full image path list
    image_paths.full = [];
    image_paths.root = finish_directory_path(image_paths.root);
    for(var n=0; n<image_paths.list.length; n++) image_paths.full.push(image_paths.root+image_paths.list[n]);

    // Send these paths to the loader and tell it what to do when complete.
    this.loader.add(image_paths.full).load(this.loader_oncomplete.bind(this)); 
  
    // Game loop counter
    this.n_loop = 0;
    this.N_loop = 0;
  }

  /** Add a thing to the queue it for when it's ready */
  add_thing(thing) { 

    // If pixi is ready, initialize / add the thing.
    if(this.ready) this._add_thing(thing);
    
    // Otherwise, push it to the queue.
    else this.queue.push(thing);
  }

  /** Internally called when pixi is ready. Actually initializes / adds the thing to the layer etc. */
  _add_thing(thing) {
    log('   _add_thing()', thing.id_thing, 'to layer', thing.settings.layer);

    // Do the pixi initialization
    thing._initialize_pixi();

    // Check special layers first

    // HANDS layer
    if(thing.settings.layer == tabletop.LAYER_HANDS) {

      // Make sure the layer exists
      if(!tabletop.layer_hands) {
        
        // Create the new layer and add it to the tabletop
        var l = new PIXI.Container();
        tabletop.layer_hands = l;
        tabletop.container.addChild(l);

        // Update the layer's coordinates / scale.
        l.x=0; l.y=0; l.rotation=0; l.scale.x=1; l.scale.y=1;
      }

      // Add the hand
      tabletop.layer_hands.addChild(thing.container);
    }

    // If the thing has a "normal" layer, the settings.layer is an integer >= 0
    else {

      // If the tabletop does not contain this layer yet, create this layer.
      if(!tabletop.layers[thing.settings.layer]) {
        
        // Create the new layer and add it to the tabletop
        var l = new PIXI.Container();
        tabletop.layers[thing.settings.layer] = l;
        tabletop.container.addChild(l);

        // Find the layer_hands and pop it to the top.
        if(tabletop.layer_hands) {
          tabletop.container.removeChild(tabletop.layer_hands);
          tabletop.container.addChild(tabletop.layer_hands);
        }

        // Update the layer's coordinates / scale.
        l.x=0; l.y=0; l.rotation=0; l.scale.x=1; l.scale.y=1;
      }

      // Add the thing to the layer
      tabletop.layers[thing.settings.layer].addChild(thing.container);

    } // End of "normal" layer

    
  }

  loader_oncomplete(e) {
    console.log('loader_oncomplete()', e);

    // Now that we have all the resources, dump the thing queue into pixi.
    while(this.queue.length) this._add_thing(this.queue.shift())
    
    // Let the world know pixi is ready.
    this.ready = true;

    // Resize the window, which sets up the table
    interaction.onresize_window();

    // Start the game loop
    log('Starting game loop...');
    pixi.app.ticker.add(delta => pixi.game_loop(delta)); 
    
    // Hide the loader so users can actually interact with the game
    html.loader.hidden = true;
  }

  /**
   * Called whenever the image loader makes some progress.
   * @param {*} loader   // loader instance
   * @param {*} resource // resource that was just loaded
   */
  loader_onprogress(loader, resource) {
    log('progress: loaded', resource.url, loader.progress, '%');

      // Update the loader progress in the html
      html.loader.innerHTML = '<h1>Loading: ' + loader.progress.toFixed(0) + '%</h1><br>' + resource.url;
  }

  /** Called every 1/60 of a second (roughly).
   * @param {float} delta // Fraction of 1/60 second since last frame.
   */
  game_loop(delta) {
    
    // Used for printing log files (slowly), etc
    this.N_loop++;
    this.n_loop++;
    this.n_loop = this.n_loop % 60;
    if(!this.n_loop) {} // log ever so often

    // Animate thing & hand movement and other internal animations
    for(var id_thing in things.all) {
      things.all[id_thing].animate_xyrs(delta);
      things.all[id_thing].animate_other(delta);
    }
    
  } // End of game_loop

} // End of MyPixi
var pixi;






// Tabletop for simplifying pan and zoom (basically a fancy container)
class Tabletop {

  constructor() {

    // Create the container to hold all the layers.
    this.container = new PIXI.Container();
    pixi.stage.addChild(this.container);
    
    this.container.x = window.innerWidth*0.5;
    this.container.y = window.innerHeight*0.5;
    this.container.rotation = 0;
    this.container.scale.x = 1;
    this.container.scale.y = 1;

    this.LAYER_HANDS = -1; // Constant for denoting the hands layer. Normal layers are positive integers.
    this.layers      = []; // List of containers for each layer
  }

  /**
   * Converts x,y from the stage surface (e.g. from a mouse event) to tabletop coordinates.
   * @param {number} x 
   * @param {number} y 
   * @returns 
   */
  xy_stage_to_tabletop(x,y) {
    
    // Undo the shift of the table top center
    var x1 = x - this.container.x;
    var y1 = y - this.container.y;

    // Undo the rotation and scale of the tabletop
    return rotate_vector(
      [x1/this.container.scale.x,
       y1/this.container.scale.y],
         -this.container.rotation);
  }

} // End of Tabletop
var tabletop; // Set in pixi.setup()





////////////////////////
// Interactions
////////////////////////
// INTERACTION MANAGER
class Interaction {
  
  constructor() {
    
    // Which mouse button is down
    this.button = -1;

    // Dictionary of functions for each key
    this.key_functions = {

      // Pan
      KeyADown:      this.pan_left,
      ArrowLeftDown: this.pan_left,
      Numpad4Down:   this.pan_left,
      
      KeyDDown:      this.pan_right,
      ArrowRightDown:this.pan_right,
      Numpad6Down:   this.pan_right,
      
      KeyWDown:      this.pan_up,
      ArrowUpDown:   this.pan_up,
      Numpad8Down:   this.pan_up,

      KeySDown:      this.pan_down,
      ArrowDownDown: this.pan_down,
      Numpad5Down:   this.pan_down,
      Numpad2Down:   this.pan_down,

      // Rotate
      ShiftKeyADown:      this.rotate_left,
      KeyQDown:           this.rotate_left,
      ShiftArrowLeftDown: this.rotate_left,
      ShiftNumpad4Down:   this.rotate_left,
      Numpad7Down:        this.rotate_left,

      ShiftKeyDDown:      this.rotate_right,
      KeyEDown:           this.rotate_right,
      ShiftArrowRightDown:this.rotate_right,
      ShiftNumpad6Down:   this.rotate_right,
      Numpad9Down:        this.rotate_right,

      // Zoom
      KeyEqualDown:       this.zoom_in,
      NumpadAddDown:      this.zoom_in,
      KeyMinusDown:       this.zoom_in,
      NumpadSubtractDown: this.zoom_out,

      // Cycle images
      SpaceDown: this.increment_selected_textures,
    }

    // Basic shapes for general-purpose use
    this.ellipse   = new PIXI.Ellipse(0,0,1,1);   // center x, y, x-radius, y-radius
    this.circle    = new PIXI.Circle(0,0,1);      // center x, y, radius
    this.rectangle = new PIXI.Rectangle(0,0,1,1); // top left x, y, width, height

    // Event listeners
    document.addEventListener('contextmenu', e => {e.preventDefault();}); 
    window  .addEventListener('resize',  this.onresize_window);
    window  .addEventListener('keydown', this.onkey.bind(this), true);
    window  .addEventListener('keyup',   this.onkey.bind(this), true);

    // Pointer interactions
    // Using the surface and objects with the built-in hit test is rough, because it
    // does it for every mouse move, etc. Also, I can't seem to get the button number
    // this way in PixiJS 6.
    //pixi.surface.interactive = true;
    //pixi.surface.on('pointerdown', this.surface_pointerdown);
    pixi.app.view.onpointerdown = this.onpointerdown.bind(this);
    pixi.app.view.onpointermove = this.onpointermove.bind(this);
    pixi.app.view.onpointerup   = this.onpointerup  .bind(this);
    pixi.app.view.onpointerout  = this.onpointerup  .bind(this);
  }

  increment_selected_textures(e) {
    log('interaction.increment_selected_textures()', e);

    // Loop over the selected items
    for(var id_thing in things.selected[clients.me.team]) 
      things.selected[clients.me.team][id_thing].increment_texture();
  }

  /**
   * Find the topmost thing at the specified tabletop location x,y, or return null
   * The thing must be within the non-special layers.
   * @param {number} x // tabletop x-coordinate
   * @param {number} y // tabletop y-coordinate
   * @returns 
   */
  find_thing_at(x,y) {
    var layer, container, x0, y0;

    // Loop over the layers from top to bottom
    for(var n=tabletop.layers.length-1; n>=0; n--) {
      layer = tabletop.layers[n];
      
      // Loop over the things in this layer from top to bottom.
      for(var m=layer.children.length-1; m>=0; m--) {

        // container of thing
        container = layer.children[m]; 
       
        // Undo the container shift and scale
        x0 = (x-container.x)/container.scale.x; 
        y0 = (y-container.y)/container.scale.y;

        // Undo the container rotation
        [x0,y0] = rotate_vector([x0,y0],-container.rotation);

        // Get the scaled bounds and test
        if(container.getLocalBounds().contains(x0,y0)) return container.thing;
      
      } // End of things in layer loop

    } // End of all layers loop
    return null;
  }

  // Pointer touches the underlying surface.
  onpointerdown(e) {
    this.last_pointerdown = e;

    // Get the tabletop coordinates
    var v = tabletop.xy_stage_to_tabletop(e.clientX, e.clientY);
    
    // Save the information
    this.button = e.button;

    // Location of the down in the two coordinate systems
    this.xd_client = e.clientX;
    this.yd_client = e.clientY;
    this.xd_tabletop = v[0];
    this.yd_tabletop = v[1];

    // Location of the tabletop at down.
    this.tabletop_xd = tabletop.container.x;
    this.tabletop_yd = tabletop.container.y;

    // Find the top thing under the pointer
    log('onpointerdown()', v, e.button, this.tabletop_xd, this.tabletop_yd);

    // Find a thing under the pointer if there is one.
    var thing = this.find_thing_at(v[0],v[1]);

    // If it's not null, handle this
    if(thing != null) {
      
      // Send to top or bottom, depending on button etc
      if     (e.button == 0) thing.send_to_top();
      else if(e.button == 2) thing.send_to_bottom();
      
      // If we're not holding shift and it's not already a thing we've selected, 
      // unselect everything.
      if(!e.shiftKey && thing.team_select != clients.me.team) things.unselect_all(clients.me.team);
      
      // If we're holding shift and it's already selected, deselect
      if(e.shiftKey && thing.team_select == clients.me.team) thing.unselect()

      // Otherwise, select it and hold everything.
      else {
        thing.select(clients.me.team); 
        things.hold_selected(net.id);
      }

      // Holding, so close fist
      if(clients && clients.me && clients.me.hand) clients.me.hand.close();

    } // End of "found thing under pointer"

    // Otherwise, we have hit the table top. unselect everything
    else things.unselect_all(clients.me.team);
  }

  // Pointer has moved around.
  onpointermove(e) { //log('onpointermove()', e.button);
    this.last_pointermove = e;
    
    // Get the tabletop coordinates
    var v = tabletop.xy_stage_to_tabletop(e.clientX, e.clientY);
    
    // Save the coordinates of the move
    this.xm_client = e.clientX;
    this.ym_client = e.clientY;
    this.xm_tabletop = v[0];
    this.ym_tabletop = v[1];

    // Only do stuff if the mouse is down
    if(this.button >= 0) {
      
      // If we have held stuff, move them around.
      if(things.held[net.id]) {
        
        // loop over our held things and move them.
        var thing;
        for(var k in things.held[net.id]) {
          thing = things.held[net.id][k];
          
          // Do the actual move, immediately
          thing.set_xyrs_target(
            thing.xh + this.xm_tabletop - this.xd_tabletop,
            thing.yh + this.ym_tabletop - this.yd_tabletop,
            undefined, undefined, true);
        }
      } 
      
      // Otherwise pan the board.
      else {
        tabletop.container.x = this.tabletop_xd + this.xm_client - this.xd_client;
        tabletop.container.y = this.tabletop_yd + this.ym_client - this.yd_client;
      }
    }

    // Move the hand
    if(clients && clients.me && clients.me.hand) {
      clients.me.hand.set_xyrs_target(this.xm_tabletop, this.ym_tabletop)
    }

  } // End of onpointermove

  onpointerup(e) { log('onpointerup()', e.button);

    // Make one last mousemove to make sure the things are where we let go of them.
    this.onpointermove(e);

    // Remember the last event
    this.last_pointerup = e;

    // Get the tabletop coordinates of this event
    var v = tabletop.xy_stage_to_tabletop(e.clientX, e.clientY);
    
    // Location of the up in two coordinate systems
    this.xu_client = e.clientX;
    this.yu_client = e.clientY;
    this.xu_tabletop = v[0];
    this.yu_tabletop = v[1];

    // Location of tabletop center at up.
    this.tabletop_xu = tabletop.container.x;
    this.tabletop_yu = tabletop.container.y;

    // Save the information
    this.button = -1;

    // Stop holding things
    things.release_all(net.id);

    // Releasing, so open fist
    if(clients && clients.me && clients.me.hand) clients.me.hand.open();
  }
  
  // Whenever a key is pressed or released.
  onkey(e) {
    this.last_onkey = e;

    // Special case for observers too: Escape toggles controls
    if(e.code == 'Escape' && e.type == 'keydown') html.toggle_controls();

    // If we're not ready, not supposed to interact with the game,
    // toggling full screen (F11), or using an input, don't 
    // change the default behavior of the keys.
    if(// !net.me.ready 
    e.code == 'F11'
    || document.activeElement.id == 'name' 
    || document.activeElement.id == 'team' 
    || document.activeElement.id == 'chat-box') return;

    // Prevent the key's normal response.
    e.preventDefault();
    
    // If the function exists, call it with the event
    var code = e.code;
    if(e.shiftKey && code.substring(0,5)!='Shift') code = 'Shift'+code;
    if(e.type == 'keyup') code = code + 'Up';
    else                  code = code + 'Down';

    // Log it
    log('onkey()', code, e.repeat);
    if(this.key_functions[code]) this.key_functions[code](e);

  } // End of onkey()

  onchange_team(e) {
    log('onchange_team()', e.target.id, e.target.selectedIndex, e.target.value);

    // Remember the team
    if(String(net.id) == e.target.id) save_cookie('team', e.target.value);

    // Update the clients list and send to server
    net.clients[e.target.id].team = e.target.selectedIndex;
    log(   'NETS_clients', net.clients);
    net.io.emit('clients', net.clients);
  } // End of onchange_team()

  // When we change our name
  onchange_name(e) {
    log('onchange_name()', e.target.id, e.target.value);

    // Remember my own name, but not others
    if(String(net.id) == e.target.id) save_cookie('name', e.target.value);

    // Update the clients list
    net.clients[net.id].name = e.target.value;
    log(   'NETS_clients', net.clients);
    net.io.emit('clients', net.clients);
  } // End of onchange_name()

  // When the volume changes.
  onchange_volume(e) {

    var v = parseInt(html.volume.value)*0.01*1.0;
    
    log('onchange_volume()', html.volume.value, v);
    
    // Change the master volume
    Howler.volume(v);
    
    // Remember the value
    save_cookie('volume',       html.volume.value);
  } // end of onchange_volume()

  /** Called when someone hits enter in the chat box.
   *  Sends a chat message to everyone else.
   */
  onchat() {
    log('onchat()');

    // Get the chat text and clear it
    var chat_box = document.getElementById('chat-box')
    var message  = html_encode(chat_box.value);
    chat_box.value = '';

    // Send a chat.
    log(   'NETS_chat', message);
    net.io.emit('chat', message);
  } // end of onchat()

  
  // Auto-adjusting pixi.app size to available space
  onresize_window(e) {
    
    // Resize the renderer
    pixi.app.renderer.resize(window.innerWidth, window.innerHeight);

    // Resize the surface
    pixi.surface.scale.x = window.innerWidth;
    pixi.surface.scale.y = window.innerHeight;
    
    log('onresize_window()');
  }
  
} // End of Interaction
var interaction; 


////////////////////////////
// SOUNDS                 //
////////////////////////////

class Sound {

  // Constructor just registers the sound and records the time
  constructor(path, volume) {
    
    // Create the howl
    this.howl = new Howl({
      src:    [path], 
      volume: volume
    });
    
    // Internal settings
    this.path = path;
  }

  // Play the sound immediately
  play(x,y,rate) {
    
    // Start play and adjust for that instance
    var id = this.howl.play();
    
    //this.howl.pos(xn, 0.5*yn, 1, id); // Requires a model to be set.
    //this.howl.stereo(0.7*xn, id); //p/Math.sqrt(1+p*p),  id);

    // Adjust the playback speed
    if(rate) this.howl.rate(rate, id);

    // return the id
    return id;
  }
}

// Library of all sounds with progress and after_loaded() function
class Sounds {

  // Constructor sets up internal data structures
  // Paths should be an object with sound options, e.g.
  // {'key':['/path/to/sound',volume], 'key2': ...}
  constructor(specs) {
    log('SoundLibrary constructor()', specs);

    // keep an eye on specs
    this.specs  = specs;
    
    // Object to remember all sounds by keys
    this.sounds = {};

    // Count the number of sounds
    this.length = 0;
    this._count(specs); 
    
    // Loop over all the specs, loading one sound per path
    this.n=0;
    this._load(specs);
  }

  // Function to recursively count the sounds in a group
  _count(object) {

    // Loop over the keys
    for(var key in object) {

      // Normal sound
      if(Array.isArray(object[key])) this.length++;
      
      // Object
      else this._count(object[key]);
    }
  }

  // Function to recursively load the sounds in a group
  _load(object) {

    // Loop over the keys
    for(var key in object) {

      // Normal sound
      if(Array.isArray(object[key])) {
        
        // Counter for progress bar.
        this.n++;
        
        // Make the new Howl to play this sound
        this.sounds[key] = new Sound(object[key][0], object[key][1]);
      
        // What to do when it loads
        this.sounds[key].howl.once('load', this._onprogress(key, object[key], Math.round(100*this.n/this.length)));
      }

      // Object. Run the load recursively.
      else this._load(object[key]);
    }
  }

  // Function called when a Howl has finished loading
  _onprogress(key, specs, percent) {
    log('SoundLibrary loaded', key, specs, percent);

    // If we hit 100%, load the volume slider
    if(percent == 100) {
    
      // Load the sound settings.
      html.volume.value = get_cookie_value('volume');
      
      // Send em.
      interaction.onchange_volume();
    }
  } // End of onprogress()

  // Play a sound by spec path. Returns [key, id]
  play(path, x, y, rate) {

    // Split the key by '/'
    var keys = path.split('/');
    
    // loop and get the spec
    var spec = this.specs;
    for(var n=0; n<keys.length; n++) spec = spec[keys[n]];

    // If spec is an array, e.g., ['spec/path/to/soundname',1], just use the last key for the name.
    if(Array.isArray(spec)) var key = keys[n-1];
    
    // Otherwise we need to pick a random key
    else var key = random_array_element(Object.keys(spec));

    // Play it and return [key,id]
    var id = this.sounds[key].play(x,y,rate);
    return [key,id];
  }

  // Old method; plays a random selection, returning [key, id]
  play_random(keys, x, y, rate) {

    var key = random_array_element(keys);
    var id  = this.sounds[key].play(x,y,rate); 
    return [key, id];
  }

  mute() {
    Howler.volume(0);
  }
  unmute() {
    interaction.onchange_volume();
  }
  set_mute(mute) {
    if(mute) this.mute();
    else     this.unmute();
  }

} // End of Sounds
var sounds; // set in pixi.setup()
      







/////////////////////////////
// THINGS                  //
/////////////////////////////

// Basic interactive object
class Thing {
  
  // Default settings for a new object
  default_settings = {
    'texture_paths' : [['nofile.png']], // paths relative to the root, with each sub-list being a layer (can animate), e.g. [['a.png','b.png'],['c.png']]
    'texture_root'  : '',               // Sub-folder in the search directories (path = image_paths.root + texture_root + path), e.g. images/
    'shape'         : 'rectangle',      // Hitbox shape.
    'type'          : null,             // User-defined types of thing, stored in this.settings.type. Could be "card" or 32, e.g.
    'sets'          : [],               // List of other sets to which this thing can belong (pieces, hands, ...)

    // Targeted x, y, r, and s
    'x' : 0,
    'y' : 0, 
    'r' : 0,
    's' : 1,

    // Layer
    'layer' : 0,
  };

  constructor(settings) {
    this.type = 'Thing';

    // This piece is not ready yet, until initializing / doing pixi stuff later.
    this.ready = false;

    // Store the settings, starting with defaults then overrides.
    this.settings = {...this.default_settings, ...settings};
    
    // Make sure the paths end with a /
    this.settings.texture_root = finish_directory_path(this.settings.texture_root);

    // Add to a user-supplied sets
    for(var n in this.settings.sets) this.settings.sets[n].add_thing(this);

    // Net id of who is selecting and controlling
    this.team_select    = -1; // Default is "unselected"
    this.id_client_hold = 0;  // Server / no client is 0

    // Shape of hitbox
    this.shape = eval('interaction.'+this.settings.shape);

    // Targeted location and geometry. Current locations are in the container.x, container.y, container.rotation, and container.scale.x
    this.x = this.settings.x;
    this.y = this.settings.y;
    this.r = this.settings.r;
    this.s = this.settings.s;

    // Current velocities
    this.vx = 0;
    this.vy = 0;
    this.vr = 0;
    this.vs = 0;

    // Starting hold location
    this.xh = this.x;
    this.yh = this.y;
    this.rh = this.r;
    this.sh = this.s;

    // Time of last movement (used for fade out animation)
    this.t_last_move    = 0;
    this.t_last_texture = 0;
    this.t_last_hold    = 0; // Last time we held the piece

    // Texture parameters
    this._n = 0;             // Current texture index

    // List of the q_out indices (nq's), indexed by key,
    // e.g., this.last_nqs['ts'] will be q_out index of the last update
    this.last_nqs = {}

    // Everything is added to the things list
    things.add_thing(this);

    // Add this to the pixi instance (or queue)
    // The pixi-related stuff must be called after pixi loads.
    pixi.add_thing(this);

  } // End of constructor.

  /** Sets the tint of all the textures */
  set_tint(color) { for(var n in this.sprites) this.sprites[n].tint = color; }
  get_tint()      { return this.sprites[0].tint; }

  _initialize_pixi() {
    
    // Make sure the paths end with a /
    image_paths.root = finish_directory_path(image_paths.root);
    
    // Keep a list of texture lists for reference, one texture list for each layer. 
    this.textures = [];
    var path; // reused in loop
    for(var n=0; n<this.settings.texture_paths.length; n++) {
      
      // One list of frames per layer; these do not have to match length
      this.textures.push([]); 
      for(var m = 0; m<this.settings.texture_paths[n].length; m++) {
        
        // Add the actual texture object
        path = image_paths.root + this.settings.texture_root + this.settings.texture_paths[n][m];
        if(pixi.resources[path]) this.textures[n].push(pixi.resources[path].texture);
        else throw 'No resource for '+ path;
      }
    }
      
    // Create a container for the stack of sprites
    this.container = new PIXI.Container();
    this.sprites   = [];
    
    // Shortcuts
    this.container.thing = this;
    
    // Loop over the layers, creating one sprite per layer
    for(var n in this.textures) {

      // Create the layer sprite with the zeroth image by default
      var sprite = new PIXI.Sprite(this.textures[n][0])
      
      // Center the image
      sprite.anchor.set(0.5, 0.5);
    
      // Keep it in our personal list, and add it to the container
      this.sprites.push(sprite);
    }

    // Add the sprites to the container (can be overloaded)
    this.fill_container();

    // This piece is ready for action.
    this.ready = true;

    // Update the coordinates
    this.animate_xyrs();
  }

  /**
   * Sets the controller id. 0 means no one is in control (server).
   */
  hold(id_client, do_not_send) {
    log('thing.hold()', this.id_thing, id_client, this.id_client_hold);

    // If the id is undefined or there is no change, do nothing (used by process_queues).
    if(id_client == undefined || id_client == this.id_client_hold) return;

    // If it's the server requesting, release
    else if(id_client == 0) this.release(do_not_send);

    // Otherwise, if it's not being held already (or the client is invalid), hold it.
    else if(this.id_client_hold == 0 || clients.all[this.id_client_hold] == undefined) {
    
      // Keep track of who is holding it
      this.id_client_hold = id_client;

      // Remember the initial coordinates
      this.xh = this.x;
      this.yh = this.y;
      this.rh = this.r;
      this.sh = this.s;    

      // Make sure there is an object to hold the held things for this id.
      if(things.held[id_client] == undefined) things.held[id_client] = {};

      // Control it
      things.held[id_client][this.id_thing] = this;

      // If we're supposed to send an update, make sure there is an entry in the queue
      this.update_q_out('id_client_hold', 'ih', do_not_send);
    } 
  } // End of hold

  /**
   * Uncontrols a thing.
   */
  release(do_not_send) {
    log('thing.release()', this.id_thing, this.id_client_hold);

    // If we're already not holding, do nothing.
    if(this.id_client_hold == 0) return;

    // Remove it from the list
    delete things.held[this.id_client_hold][this.id_thing];

    // If it was me holding it, remember the time I let go.
    if(this.id_client_hold == net.id) this.t_last_hold = Date.now();
    this.id_client_hold = 0;

    // If we're supposed to send an update, make sure there is an entry in the queue
    this.update_q_out('id_client_hold', 'ih', do_not_send);
  }

  /**
   * Selects the thing visually and adds it to the approriate list of selected things.
   */
  select(team, do_not_send) {
    log('thing.select()', this.id_thing, team);

    // If team is not specified or it's not a change, do nothing. Used by process_queues.
    if(team == undefined || team == this.team_select) return;

    // If team is -1, unselect it
    if(team < 0) return this.unselect(do_not_send);

    // If there is any team selecting this already, make sure to unselect it to remove it
    // from other lists! (Do not send a network packet for this).
    if(this.team_select != -1) this.unselect(true); 

    // Keep track of the selected team.
    this.team_select = team;

    // If we're supposed to send an update, make sure there is an entry in the queue
    this.update_q_out('team_select', 'ts', do_not_send);

    // Make sure there is an object to hold selected things for this id
    if(things.selected[team] == undefined) things.selected[team] = {};

    // Select it
    things.selected[team][this.id_thing] = this;
    this.container.filters = [new __filters.GlowFilter({
      distance:20,
      outerStrength:5,
      innerStrength:1,
      color:game.get_team_color(team),
      quality:0.1,
    })];
  } // End of select()

  /**
   * Unselects thing. This will not unselect anything held by someone else.
   */
  unselect(do_not_send) { log('thing.unselect()', this.id_thing, this.selected_id);

    // If we're already unselected, do nothing
    if(this.team_select < 0) return;

    // Remove it from the list
    if(things.selected[this.team_select] &&
       things.selected[this.team_select][this.id_thing])
        delete things.selected[this.team_select][this.id_thing];
    this.team_select = -1;

    // If we're supposed to send an update, make sure there is an entry in the queue
    this.update_q_out('team_select', 'ts', do_not_send);

    // Unglow it
    this.container.filters = [];

  } // End of unselect()

  /* Sends data associated with key (this[key]) to the associated net.q_pieces_out[this.id_thing][qkey]. */
  update_q_out(key, qkey, only_if_exists) { 
    //log('Thing.update_q_out()', key, qkey, only_if_exists);
    
    // If qkey is not supplied, use the key
    if(qkey == undefined) qkey = key;

    // Get the appropriate id and q.
    if(this.type == 'Piece') {
      var q_out = net.q_pieces_out;
      var id    = this.id_piece;
    }
    else if(this.type == 'Hand') {
      var q_out = net.q_hands_out;
      var id    = this.id_hand;
    }

    // If we are only updating what exists, look for the key
    if(only_if_exists) {

      // If the piece or qkey doesn't exist already, we're done!
      if(!q_out[id])       return;
      if(!q_out[id][qkey]) return;
    }

    // Otherwise, make sure the queue has an object to hold this data
    else if(!q_out[id]) q_out[id] = {};

    // Update the attribute
    q_out[id][qkey] = this[key];

    // Remember the index that will be attached to this on the next process_qs
    this.last_nqs[qkey] = net.nq+1;
  }

  send_to_top() {

    // Get the parent of the container
    var parent = this.container.parent;
    
    // If it exists, send it to the top of the parent's list.
    if (parent) {		
      parent.removeChild(this.container);		
      parent.addChild(this.container);	
    }
  }

  send_to_bottom() {

    // Get the parent of this container
    var parent = this.container.parent;
    
    // If the parent is valid, pop out the container and stuff it at the start.
    if(parent) {
      parent.removeChild(this.container);
      parent.addChildAt(this.container, 0);	  
    }
  }

  /**
   * Fills the container with all the sprites. This can be overloaded for more complex
   * Things.
   */
  fill_container() {
    for(var i=0; i<this.sprites.length; i++) 
      this.container.addChild(this.sprites[i]);
  }

  get_dimensions() {
    var w = 0, h = 0;

    // Loop over the layers, keeping the largest dimensions
    for(var l=0; l<this.sprites.length; l++) {
      var s = this.sprites[l];
      if(s.width  > w) w = s.width;
      if(s.height > h) h = s.height;
    }
    return [w,h];
  }

  /**
   * Sets the texture index and resets the clock.
   */
  set_texture_index(n, do_not_send) {
    if(n == undefined) return;

    // Loop over the layers, setting the texture of each
    for(var l=0; l<this.sprites.length; l++) {
        
      // Figure out the valid index (make sure there's a texture!)
      var n_valid = n % this.textures[l].length;
      
      // Set the texture to a valid one.
      this.sprites[l].texture = this.textures[l][n_valid];
    }

    // Remember the index we're on for cycling purposes
    this._n = n_valid;
    log('Piece.set_texture_index()', this._n, do_not_send);

    // If we're supposed to send an update, make sure there is an entry in the queue
    this.update_q_out('_n', 'n', do_not_send);

    // Record the time of this switch for animation purposes
    this.t_last_texture = Date.now();

    // Finish this function for function finishing purposes
  }
  
  // Increment the texture
  increment_texture() {
    log('Piece.increment_texture()', this.id, this._n+1);
    this.set_texture_index(this._n+1);
  }

  // Increment the texture if we've passed a certain amount of time
  increment_texture_delayed() {
    if(Date.now() - this.t_last_texture > this.t_texture_delay)
      this.increment_texture();
  }

  // show / hide the sprite
  show(invert)  {
    if(invert) this.container.visible = false;
    else       this.container.visible = true;
  }
  hide(invert) {
    if(invert) this.container.visible = true;
    else       this.container.visible = false;
  }
  set_visible(enabled) {this.show(!enabled);}

  is_enabled()  {return  this.container.visible;}
  is_disabled() {return !this.container.visible;}

  /**
   * Returns an object with x, y, r, and s.
   */
  get_xyrs_target() {return {x:this.x, y:this.y, r:this.r, s:this.s}}

  /** 
   * Sets the target x,y,r,s for the sprite.
   * 
   */
  set_xyrs_target(x,y,r,s,immediate,do_not_send) { 

    // Now for each supplied coordinate, update and send
    if(x!=undefined && x != this.x) {this.x = x; if(immediate) this.container.x = x; this.update_q_out('x', 'x', do_not_send);}
    if(y!=undefined && y != this.y) {this.y = y; if(immediate) this.container.y = y; this.update_q_out('y', 'y', do_not_send);}
    if(r!=undefined && r != this.r) {this.r = r; if(immediate) this.container.r = r; this.update_q_out('r', 'r', do_not_send);}
    if(s!=undefined && s != this.s) {
      this.s = s; if(immediate) {this.container.scale.x = s; this.container.scale.y = s}; 
      this.update_q_out('s', 's', do_not_send);
    }
    this.t_last_move = Date.now();
  }

  /**
   * Updates the actual sprite location / geometry via the error decay animation, 
   * and should be called once per frame.
   */
  animate_xyrs(delta) { if(!delta) delta = 1;
    
    // Don't do anything until it's been initialized / added to pixi.
    if(!this.ready) {return;}

    //if(pixi.N_loop == 1 && this.id_thing > 2) log('N_loop ==',pixi.N_loop,':', this.vr, this);

    // Use the current location and target location to determine
    // the target velocity. Target velocity should be proportional to the distance.
    // We want it to arrive in (game.t_transition) / (16.7 ms) frames
    var a = (delta*16.7)/game.settings.t_transition; // inverse number of frames at max velocity 
    var vx_target = a*(this.x - this.container.x);
    var vy_target = a*(this.y - this.container.y);
    var vr_target = a*(this.r - this.container.rotation);
    var vs_target = a*(this.s - this.container.scale.x);

    // Adjust the velocity as per the acceleration
    var b = (delta*16.7)/game.settings.t_acceleration; // inverse number of frames to get to max velocity
    var Ax = b*(vx_target - this.vx);
    var Ay = b*(vy_target - this.vy);
    var Ar = b*(vr_target - this.vr);
    var As = b*(vs_target - this.vs);
    
    // If we're slowing down, do it MORE to avoid overshoot
    if(Math.sign(Ax)!=Math.sign(this.vx)) Ax = Ax*2;
    if(Math.sign(Ay)!=Math.sign(this.vy)) Ay = Ay*2;
    if(Math.sign(Ar)!=Math.sign(this.vr)) Ar = Ar*2;
    if(Math.sign(As)!=Math.sign(this.vs)) As = As*2;

    this.vx += Ax;
    this.vy += Ay;
    this.vr += Ar;
    this.vs += As;

    // Set the actual position, rotation, and scale
    this.container.x        += this.vx;
    this.container.y        += this.vy;
    this.container.rotation += this.vr;
    this.container.scale.x  += this.vs;
    this.container.scale.y  += this.vs;
  }

  /** Other animations, like sprite image changes etc, to be overloaded. */
  animate_other(delta) { if(!delta) delta = 1;}

} // End of Thing

class Things {

  constructor() {

    // List of all things in order, such that the index is their id_thing.
    this.all      = [];
    this.selected = {}; // lists of things selected, indexed by team
    this.held     = {}; // lists of things held, indexed by client id
  }

  /** Releases all things with the supplied client id. */
  release_all(id_client) { log('Things.release_all()', id_client, this.held[id_client]);
    
    // If we have a held list for this client id
    if(this.held[id_client]) {
      
      // Loop over the list and reset the id_client_hold
      for(var id_thing in this.held[id_client]) this.held[id_client][id_thing].release()

      // Delete the list
      delete this.held[id_client];
    }
  }

  /** Adds a Thing to the list, and queues it for addition to the table. */
  add_thing(thing) {

    // Assign the thing id, and add it to the global lookup table
    thing.id_thing = this.all.length;
    this.all.push(thing);
  }

  /**
   * Sets up the drag for all selected things for this team
   * @param {int} team 
   */
  hold_selected(id_client) { log('things.hold_selected()', id_client);

    // Loop over the selected things and hold whatever isn't already held by someone else.
    for(var k in this.selected[clients.all[id_client].team]) 
      this.selected[clients.all[id_client].team][k].hold(id_client);
  }

  /**
   * unselect all things for this team.
   */
  unselect_all(team) { log('things.unselect_all()', team);

    // Loop over all the selected things and pop them.
    for(var k in this.selected[team]) this.selected[team][k].unselect(); 
  }

} // End of Things
things = new Things();


/** Selectable, manipulatable thing */
class Piece extends Thing {

  constructor(settings) { if(!settings) settings = {};

    // Include the sets and run the usual initialization
    settings.sets = [pieces];
    super(settings);

    // Remember what type of object this is.
    this.type = 'Piece';
  }

  /** Returns true if the piece is in the output q. If key is specified,
   * Returns true only if the piece and key are in the output q.
   */
  in_q_out(key) {
    
    // If the piece exists in the out q
    if(net.q_pieces_out[this.id_piece]) {

      // If key is undefined, return true
      if(key == undefined) return true;

      // Otherwise, if the value is undefined it's not in the q
      else if(net.q_pieces_out[this.id_piece][key] == undefined) return false

      // Gues the key is in the q, huh. Huh.
      else return true;
    }

    // No piece!
    else return false;
  }
}
// List of pieces for convenience
class Pieces { constructor() {this.all = [];}

  // Adds a thing to the list, and queues it for addition to the table. 
  add_thing(piece) {
    piece.id_piece = this.all.length;
    this.all.push(piece);
  }
}
pieces = new Pieces();

/** Floating hand on top of everything. */
class Hand extends Thing {

  constructor() {

    // Create the settings for a hand
    var settings = {
      texture_paths : [['hand.png', 'fist.png']], // paths relative to the root
      texture_root     : 'hands',                   // Image root path.
      layer         : tabletop.LAYER_HANDS,       // Hands layer.
      t_pause       : 1200,                       // How long to wait since last move before faiding out.
      t_fade        : 500,                        // Time to fade out.
      sets          : [hands],                    // Other sets it belongs to
    }

    // Run the usual thing initialization
    super(settings);

    // Remember the type
    this.type = 'Hand';

    // id of client this hand belongs to
    this.id_client = 0;

    log('new Hand()', this.vx, this.x); pixi.N_loop = 0;
  }

  /** Closes / opens the hand */
  close() {this.set_texture_index(1);}
  open()  {this.set_texture_index(0);}
  is_closed() {return this._n == 1;}
  is_open()   {return this._n == 0;}

  /** Sets t_last_move to the current time to show the hand. */
  ping() {this.t_last_move = Date.now();}

  /** Other animations, like sprite image changes etc, to be overloaded. */
  animate_other(delta) { if(!delta) delta = 1;
    
    var t0 = Math.max(this.t_last_texture, this.t_last_move);

    // All we do is fade it out after some time.
    if(this.is_open()) this.container.alpha = fader_smooth(t0+this.settings.t_pause, this.settings.t_fade);
    else               this.container.alpha = 1;
  }
} // End of Hand

// List of hands for convenience
class Hands { constructor() {this.all = [];}

  // Adds a thing to the list, and queues it for addition to the table. 
  add_thing(hand) {
    hand.id_hand = this.all.length;
    this.all.push(hand);
  }

  /** Finds a free hand or creates and returns one */ 
  get_unused_hand() {
    for(var l in this.all) { 

      // If we found a free one, use it
      if(this.all[l].id_client == 0) return this.all[l];

    } // End of loop over hands
    
    // If we haven't returned yet, we need a new one
    return new Hand();
  }

  /** Frees all hands from ownership */
  free_all_hands() { for(var l in this.all) this.all[l].id_client = 0; }

  /** Just shows them all briefly */
  ping() {for(var l in this.all) this.all[l].ping();}
}
hands = new Hands();

/** Keeps track of the client objects and information not sent over the net. */
class Clients {

  constructor() {

    // list by net id of client stuff
    this.all = {};
  }

  /** Rebuilds the client list and GUI based on net.clients. */
  rebuild() {
    log('clients.rebuild()');

    // Clear out the list
    this.all = {};

    // Unassign all hands (sets id_client to 0)
    hands.free_all_hands();

    // Loop over the client list
    for (var k in net.clients) {var c = net.clients[k];
      log('  client', c.id, c.name, c.team, game.settings.teams[c.team]);
    
      // Store everything for this client.
      this.all[c.id] = {
        name  : c.name,
        team  : c.team, // index
        color : game.get_team_color(c.team),
        hand  : hands.get_unused_hand(),
      }

      // Set the hand id_client
      this.all[c.id].hand.id_client = c.id;
      
      // Show all hands but my own
      if(c.id == net.id) this.all[c.id].hand.hide();
      else               this.all[c.id].hand.show();

      // Update the hand color
      this.all[c.id].hand.set_tint(this.all[c.id].color);

    } // End of loop over client list

    // Keep track of me
    this.me = this.all[net.id];

    // Finally, using the current net.clients, rebuild the html table.
    html.rebuild_client_table();
  }
}
clients = new Clients();

/** Class that holds all the game info: things, teams, rules, etc. */
class Game {

  // Default minimal settings that can be overridden.
  default_settings = {

    // Available teams for clients and their colors.
    teams : {
      Observer : 0xFFFFFF,
      Red      : 0xFF2A2A,
      Gray     : 0x808080,
      Yellow   : 0xFFE84B,
      Orange   : 0xFF6600,
      Blue     : 0x5599FF,
      Green    : 0x118855,
      Violet   : 0xD62CFF,
      Brown    : 0x883300,
      Manager  : 0x333333
    },

    // Available game setup modes
    setups : ['Standard'],

    // How long to wait in between housekeepings.
    t_housekeeping : 250,
    t_hold_block   : 550,
    t_transition   : 300, // Time to transition coordinates at full speed
    t_acceleration : 200, // Time to get to full speed
  }

  constructor(settings) {
    
    // Store the settings, starting with defaults then overrides.
    this.settings = {...this.default_settings, ...settings};

    // Create the big objects that depend on game stuff.
    pixi        = new Pixi();
    tabletop    = new Tabletop();
    interaction = new Interaction();
    sounds      = new Sounds(sound_list)

    // Add elements to the setups combo box
    for (var k in this.settings.setups) {
        var o = document.createElement("option");
        o.value = this.settings.setups[k];
        o.text  = this.settings.setups[k];
        html.setups.appendChild(o);
    }

    // Start the quarter-second housekeeping
    setInterval(this.housekeeping.bind(this), this.settings.t_housekeeping);
  }

  /** Gets the team name from the list index. */
  get_team_name(n) {return Object.keys(this.settings.teams)[n];}

  /** Gets the team index from the name. Returns -1 for "not in list" */
  get_team_index(name) {return Object.keys(this.settings.teams).indexOf(name);  }

  /** Gets the color from the index */
  get_team_color(n) {return this.settings.teams[Object.keys(this.settings.teams)[n]]; }

  /** Function called every quarter second to do housekeeping. */
  housekeeping(e) {

    // If Pixi has finally finished loading, we still haven't connected, 
    // and everything is loaded, connect to server
    if(pixi.ready && !net.ready && pixi.queue.length==0) net.connect_to_server();

    // Process net queues.
    net.process_queues();

  } // End of housekeeping.

} // End of Game































////////////////////////////////
// LOCAL STUFF
////////////////////////////////

// Local cookies not sync'd with server
if(get_cookie_value('setup') != '') html.setup.value = get_cookie_value('setup');