// NOT COMPILED YET: written without an Unreal Engine installation. See unreal/README.md.
using UnrealBuildTool;

public class MVWBackend : ModuleRules
{
	public MVWBackend(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "HTTP", "Json", "InputCore" });
	}
}
