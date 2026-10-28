// 仅包含锁定 bevy_egui 源码中明确的 ECS 结构操作、World 借用和消息发布。
const message=(type,match,condition,extra={})=>({kind:'Messages<T>',type,operation:'publish',via:'message_writer',method:'write',match,condition,...extra});
const component=(type,method,match,condition,extra={})=>({kind:'Component',type,operation:method==='remove'?'remove':'insert',via:'commands',method,match,condition,...extra});
const resource=(type,method,match,condition)=>({kind:'Resource',type,operation:method==='remove_resource'?'remove':'insert',via:'commands',method,match,condition});
export const EGUI_SCHEDULE_BODY_OPERATIONS={
  'bevy_egui::input::write_file_dnd_messages_system':[message('EguiFileDragAndDropMessage','egui_file_dnd_message_writer.write(EguiFileDragAndDropMessage {','上下文允许拖放输入时，把DroppedFile、HoveredFile及HoveredFileCanceled各分支发布到对应Egui上下文。',{allMatches:true})],
  'bevy_egui::input::write_ime_messages_system':[message('EguiInputEvent','egui_input_message_writer.write(EguiInputEvent {','上下文允许IME时，发布Preedit和Commit转换事件；Enabled、Disabled分支不发布。',{allMatches:true})],
  'bevy_egui::input::write_keyboard_input_messages_system':[message('EguiInputEvent','egui_input_message_writer.write(EguiInputEvent {','按上下文输入开关发布文本、按键及可用剪贴板快捷键事件。',{allMatches:true})],
  'bevy_egui::input::write_mouse_wheel_messages_system':[message('EguiInputEvent','egui_input_message_writer.write(EguiInputEvent {','对应上下文允许滚轮输入时，发布转换后的MouseWheel事件。')],
  'bevy_egui::input::write_non_window_pointer_moved_messages_system':[message('EguiInputEvent','egui_input_message_writer.write(EguiInputEvent {','存在悬停非窗口上下文且允许指针移动输入时，发布该上下文的指针位置。')],
  'bevy_egui::input::write_pinch_gesture_messages_system':[message('EguiInputEvent','egui_input_message_writer.write(EguiInputEvent {','把缩放手势发布给悬停非窗口上下文，或全部已映射窗口上下文。',{allMatches:true})],
  'bevy_egui::input::write_pointer_moved_and_button_messages_system':[
    message('EguiInputEvent','egui_input_message_writer.write(EguiInputEvent {','按全局和上下文开关发布指针移动或按钮事件。',{allMatches:true}),
    resource('FocusedNonWindowEguiContext','insert_resource','commands.insert_resource(FocusedNonWindowEguiContext(hovered_context.0))','允许自动更新焦点且按钮按下时，悬停非窗口上下文成为焦点。'),
    resource('FocusedNonWindowEguiContext','remove_resource','commands.remove_resource::<FocusedNonWindowEguiContext>()','允许自动更新焦点且按钮按下时，没有悬停非窗口上下文则移除焦点。'),
  ],
  'bevy_egui::input::write_window_touch_messages_system':[
    resource('FocusedNonWindowEguiContext','insert_resource','commands.insert_resource(FocusedNonWindowEguiContext(','允许自动更新焦点且触摸开始时，已有悬停非窗口上下文则排入焦点并跳过窗口触摸处理。'),
    resource('FocusedNonWindowEguiContext','remove_resource','commands.remove_resource::<FocusedNonWindowEguiContext>()','允许自动更新焦点且窗口触摸开始时，没有悬停非窗口上下文则移除焦点。'),
    message('EguiInputEvent','egui_input_message_writer.write(EguiInputEvent {','上下文允许触摸输入时，helper发布触摸和相应鼠标模拟事件。',{helper:'bevy_egui::input::write_touch_message',callMatch:'write_touch_message(',allMatches:true}),
  ],
  'bevy_egui::input::write_non_window_touch_messages_system':[message('EguiInputEvent','egui_input_message_writer.write(EguiInputEvent {','焦点非窗口上下文允许触摸输入时，helper发布触摸和相应鼠标模拟事件。',{helper:'bevy_egui::input::write_touch_message',callMatch:'write_touch_message(',allMatches:true})],
  'bevy_egui::output::process_output_system':[
    component('bevy_window::CursorIcon','try_insert','.try_insert(CursorIcon::System(','上下文对应窗口存在且输出光标图标改变时，排入窗口CursorIcon更新。'),
    message('bevy_window::RequestRedraw','request_redraw_writer.write(RequestRedraw)','任一处理的上下文要求立即重新绘制时发布RequestRedraw。'),
  ],
  'bevy_egui::render::extract_egui_camera_view_system':[
    {kind:'QueryData',type:'RenderEntity',operation:'reference',via:'world',method:'query',match:'world.query::<(',scope:'main',condition:'主世界查询的SubEntity<RenderApp>身份接口，用于取得对应渲染实体。'},
    ...['Camera','EguiOutput'].map(type=>({kind:'Component',type,operation:'read',via:'world',method:'query',match:'world.query::<(',scope:'main',condition:'读取主世界相机视口、启用状态及Egui像素输出配置。'})),
    {kind:'Component',type:'EguiRenderOutput',operation:'mutable_access',via:'world',method:'query',match:'world.query::<(',scope:'main',condition:'通过主世界可变查询取走Egui绘制形状和纹理增量，供渲染世界使用。'},
    component('EguiCameraView','remove','.remove::<EguiCameraView>()','主相机停用或带Disabled时，移除其渲染实体的EguiCameraView关联。'),
    ...['ExtractedView','EguiViewTarget','EguiRenderOutput','EguiPixelsPerPoint','TemporaryRenderEntity'].map(type=>component(type,'spawn','commands.spawn((ExtractedView {','相机有有效物理视口时生成Egui子视图；EguiRenderOutput来自主世界查询的实际提取值。')),
    component('EguiCameraView','insert','entity_commands.insert(EguiCameraView(ui_camera_view))','生成Egui子视图后，给主相机对应渲染实体插入指向子视图的关联。'),
  ],
  'bevy_egui::render::render_pass::egui_pass':['EguiPipelines','PipelineCache','EguiRenderData','EguiTextureBindGroups','EguiTransforms'].map(type=>({kind:'Resource',type,operation:'read',via:'world',method:'resource',match:'world.resource::<'+type+'>()'})),
  'bevy_egui::render::render_pass::prepare_egui_pass':[{kind:'Resource',type:'EguiRenderData',operation:'mutable_access',via:'world',method:'resource_scope',match:'world.resource_scope(|world, mut render_data: Mut<EguiRenderData>|',condition:'在资源作用域取得EguiRenderData的真实可变引用，遍历并排空待执行绘制回调更新。'}],
  'bevy_egui::render::systems::queue_bind_groups_system':[resource('EguiTextureBindGroups','insert_resource','commands.insert_resource(EguiTextureBindGroups(bind_groups))','按当前纹理及bindless配置建立绑定组后，排入整张绑定组表。')],
  'bevy_egui::render::systems::queue_pipelines_system':[resource('EguiPipelines','insert_resource','commands.insert_resource(EguiPipelines(pipelines))','根据每个视图的目标格式专用化管线后，排入主实体到管线ID的映射。')],
  'bevy_egui::run_egui_context_pass_loop_system':[{kind:'QueryData',type:'EguiPassQuery',operation:'reference',via:'world',method:'query',match:'world.query::<EguiPassQuery>()',condition:'独占系统使用真实EguiPassQuery接口，挑选非手动上下文并运行其指定Schedule；内部字段访问由该QueryData声明说明。'}],
  'bevy_egui::setup_primary_egui_context_system':['EguiContext','PrimaryEguiContext'].map(type=>component(type,'insert','camera_commands.insert((context, PrimaryEguiContext))','尚无主Egui上下文且遇到新相机时，插入默认上下文和主上下文标记。',{evidenceMatch:'let context = EguiContext::default()'})),
};
export const EGUI_SCHEDULE_BODY_GAPS={
  'bevy_egui::render::render_pass::prepare_egui_pass':['绘制回调通过动态cb().update(...,world)实现，无法从固定源码目录穷举用户回调对World的操作；已核实EguiRenderData资源作用域。'],
};
