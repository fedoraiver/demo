//! 运行资源从 assets 加载；制作源文件和美术清单不参与游戏运行时依赖。

use bevy::{
    asset::{LoadState, RecursiveDependencyLoadState, RenderAssetUsages},
    gltf::GltfLoaderSettings,
    prelude::*,
};

pub(crate) const ISLAND_PATH: &str = "maps/courier_island.glb";
pub(crate) const COURIER_PATH: &str = "models/characters/chr_courier.glb";

/// 物品的美术种类；搬运能力和持有关系仍由玩法组件保存。
#[derive(Component, Reflect, Clone, Copy, Default, Debug, PartialEq, Eq)]
#[reflect(Component)]
pub(crate) enum ItemModel {
    #[default]
    StandardParcel,
    FragileParcel,
    WoodenCrate,
}

impl ItemModel {
    pub(crate) fn path(self) -> &'static str {
        match self {
            Self::StandardParcel => "models/props/prop_parcel_standard.glb",
            Self::FragileParcel => "models/props/prop_parcel_fragile.glb",
            Self::WoodenCrate => "models/props/prop_crate.glb",
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::StandardParcel => "standard_parcel",
            Self::FragileParcel => "fragile_parcel",
            Self::WoodenCrate => "wooden_crate",
        }
    }
}

/// 强句柄覆盖海岛、主角和动态道具的生命周期，NPC 与环境由组合地图提供。
#[derive(Resource)]
pub(crate) struct ArtAssets {
    pub(crate) island: Handle<Gltf>,
    pub(crate) courier: Handle<Gltf>,
    standard: Handle<Gltf>,
    fragile: Handle<Gltf>,
    wooden_crate: Handle<Gltf>,
}

impl FromWorld for ArtAssets {
    fn from_world(world: &mut World) -> Self {
        let server = world.resource::<AssetServer>();
        let load = |path: &'static str| {
            server
                .load_builder()
                .with_settings(|settings: &mut GltfLoaderSettings| {
                    // 静态碰撞需要 CPU 顶点；禁止在上传 GPU 后丢弃地图几何。
                    settings.load_meshes =
                        RenderAssetUsages::MAIN_WORLD | RenderAssetUsages::RENDER_WORLD;
                    settings.load_cameras = false;
                    settings.load_lights = false;
                })
                .load(path)
        };
        Self {
            island: load(ISLAND_PATH),
            courier: load(COURIER_PATH),
            standard: load(ItemModel::StandardParcel.path()),
            fragile: load(ItemModel::FragileParcel.path()),
            wooden_crate: load(ItemModel::WoodenCrate.path()),
        }
    }
}

impl ArtAssets {
    pub(crate) fn item(&self, model: ItemModel) -> &Handle<Gltf> {
        match model {
            ItemModel::StandardParcel => &self.standard,
            ItemModel::FragileParcel => &self.fragile,
            ItemModel::WoodenCrate => &self.wooden_crate,
        }
    }

    fn entries(&self) -> [(&'static str, &Handle<Gltf>); 5] {
        [
            (ISLAND_PATH, &self.island),
            (COURIER_PATH, &self.courier),
            (ItemModel::StandardParcel.path(), &self.standard),
            (ItemModel::FragileParcel.path(), &self.fragile),
            (ItemModel::WoodenCrate.path(), &self.wooden_crate),
        ]
    }
}

/// 资源就绪与地图碰撞就绪是两个门槛，不能仅凭模板已生成就推进物理。
#[derive(Resource, Default, PartialEq, Eq)]
pub(crate) enum ArtLoadState {
    #[default]
    Loading,
    Ready,
    Failed,
}

/// 集中加载和报告失败，沿用统一会话日志。
pub(crate) struct ArtAssetsPlugin;

impl Plugin for ArtAssetsPlugin {
    fn build(&self, app: &mut App) {
        app.register_type::<ItemModel>()
            .init_resource::<ArtAssets>()
            .init_resource::<ArtLoadState>()
            .add_systems(Startup, log_asset_requests)
            .add_systems(Update, poll_art_assets);
    }
}

fn log_asset_requests(assets: Res<ArtAssets>) {
    for (path, _) in assets.entries() {
        info!(target: "demo::art_assets", path, state = "loading",
            reason = "scene_startup", "Art asset requested");
    }
}

/// 连同子资产检查失败；只记录状态切换，避免每帧刷写相同错误。
fn poll_art_assets(
    server: Res<AssetServer>,
    assets: Res<ArtAssets>,
    mut state: ResMut<ArtLoadState>,
) {
    if *state != ArtLoadState::Loading {
        return;
    }
    let mut ready = true;
    for (path, handle) in assets.entries() {
        let failure = match server.get_load_state(handle.id()) {
            Some(LoadState::Failed(error)) => Some(error),
            _ => match server.get_recursive_dependency_load_state(handle.id()) {
                Some(RecursiveDependencyLoadState::Failed(error)) => Some(error),
                _ => None,
            },
        };
        if let Some(error) = failure {
            *state = ArtLoadState::Failed;
            error!(target: "demo::art_assets", path, error = %error,
                state_before = "loading", state_after = "failed",
                reason = "asset_load_failed", "Art asset loading failed");
            return;
        }
        ready &= server.is_loaded_with_dependencies(handle.id());
    }
    if ready {
        *state = ArtLoadState::Ready;
        info!(target: "demo::art_assets", asset_count = assets.entries().len(),
            state_before = "loading", state_after = "ready",
            reason = "dependencies_loaded", "Art assets ready");
    }
}
